/**
 * Kafka Consumer
 *
 * Consumes events from Kafka topic and writes them to MongoDB.
 * Features:
 * - Consumer group for horizontal scaling
 * - Batch processing for performance
 * - Dead-letter queue for failed messages
 * - Graceful shutdown
 * - Prometheus metrics
 *
 * Related: ADR-0034 (Kafka Event Streaming Integration)
 */

const { Kafka, logLevel } = require('kafkajs');
const config = require('../config');
const mongoWriter = require('../database/mongoWriter');

/**
 * Kafka Consumer Class
 */
class KafkaEventConsumer {
  constructor() {
    this.kafka = null;
    this.consumer = null;
    this.dlqProducer = null;
    this.isRunning = false;
    this.isShuttingDown = false;

    // Batch processing
    this.messageBatch = [];
    this.batchTimer = null;

    // Metrics
    this.metrics = {
      messagesReceived: 0,
      messagesProcessed: 0,
      messagesFailed: 0,
      batchesProcessed: 0,
      dlqMessages: 0,
      lastProcessedTimestamp: null,
      consumerLag: 0,
    };
  }

  /**
   * Initialize Kafka consumer and DLQ producer
   */
  async initialize() {
    try {
      console.log('[Kafka Consumer] Initializing...');

      // Create Kafka client
      this.kafka = new Kafka({
        clientId: config.kafka.clientId,
        brokers: config.kafka.brokers,
        connectionTimeout: 10000,
        requestTimeout: 5000,
        retry: {
          initialRetryTime: 100,
          retries: 8,
          maxRetryTime: 5000,
          multiplier: 2,
        },
        logLevel: config.env === 'production' ? logLevel.ERROR : logLevel.WARN,
      });

      // Create consumer
      this.consumer = this.kafka.consumer({
        groupId: config.kafka.groupId,
        sessionTimeout: config.kafka.consumer.sessionTimeout,
        heartbeatInterval: config.kafka.consumer.heartbeatInterval,
        maxBytesPerPartition: config.kafka.consumer.maxBytesPerPartition,
        retry: {
          initialRetryTime: 100,
          retries: 8,
          maxRetryTime: 5000,
          multiplier: 2,
        },
      });

      // Create DLQ producer for failed messages
      this.dlqProducer = this.kafka.producer({
        allowAutoTopicCreation: true,
        idempotent: true,
        maxInFlightRequests: 5,
        retry: {
          initialRetryTime: 100,
          retries: 8,
          maxRetryTime: 5000,
          multiplier: 2,
        },
      });

      console.log('[Kafka Consumer] Initialization complete');
    } catch (error) {
      console.error('[Kafka Consumer] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Start consuming messages
   */
  async start() {
    try {
      console.log('[Kafka Consumer] Starting...');

      // Connect consumer
      await this.consumer.connect();
      console.log('[Kafka Consumer] Consumer connected');

      // Connect DLQ producer
      await this.dlqProducer.connect();
      console.log('[Kafka Consumer] DLQ producer connected');

      // Subscribe to topic
      await this.consumer.subscribe({
        topic: config.kafka.topic,
        fromBeginning: false, // Start from latest on first run
      });

      console.log(`[Kafka Consumer] Subscribed to topic: ${config.kafka.topic}`);

      this.isRunning = true;

      // Start consuming
      await this.consumer.run({
        autoCommit: config.kafka.consumer.autoCommit,
        autoCommitInterval: config.kafka.consumer.autoCommitInterval,
        eachBatchAutoResolve: true,
        eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning }) => {
          await this.processBatch(batch, resolveOffset, heartbeat, isRunning);
        },
      });

      console.log('[Kafka Consumer] Started successfully');
    } catch (error) {
      console.error('[Kafka Consumer] Failed to start:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Process a batch of messages
   */
  async processBatch(batch, resolveOffset, heartbeat, isRunning) {
    const { topic, partition, messages } = batch;

    console.log(`[Kafka Consumer] Processing batch: ${messages.length} messages from ${topic}[${partition}]`);

    this.metrics.messagesReceived += messages.length;

    for (const message of messages) {
      if (!isRunning() || this.isShuttingDown) {
        console.log('[Kafka Consumer] Shutdown detected, stopping batch processing');
        break;
      }

      try {
        // Parse CloudEvent
        const event = this.parseMessage(message);

        if (!event) {
          console.error('[Kafka Consumer] Failed to parse message, sending to DLQ');
          await this.sendToDLQ(message, 'Invalid message format');
          resolveOffset(message.offset);
          continue;
        }

        // Write to MongoDB
        const result = await mongoWriter.writeEventWithRetry(event);

        if (result.success) {
          this.metrics.messagesProcessed++;
          this.metrics.lastProcessedTimestamp = Date.now();

          if (!result.duplicate) {
            console.log(`[Kafka Consumer] Event processed: ${event.id} (${event.type})`);
          }
        }

        // Commit offset
        resolveOffset(message.offset);

        // Send heartbeat periodically
        await heartbeat();

      } catch (error) {
        this.metrics.messagesFailed++;
        console.error('[Kafka Consumer] Failed to process message:', error);

        // Send failed message to DLQ
        try {
          await this.sendToDLQ(message, error.message);
          resolveOffset(message.offset); // Commit even if failed (already in DLQ)
        } catch (dlqError) {
          console.error('[Kafka Consumer] Failed to send message to DLQ:', dlqError);
          // Don't commit offset - will retry on next poll
          throw dlqError;
        }
      }
    }

    this.metrics.batchesProcessed++;
  }

  /**
   * Parse Kafka message to CloudEvent
   */
  parseMessage(message) {
    try {
      const value = message.value.toString();
      const event = JSON.parse(value);

      // Validate required CloudEvent fields
      if (!event.id || !event.type || !event.source || !event.time) {
        console.error('[Kafka Consumer] Invalid CloudEvent format:', event);
        return null;
      }

      return event;
    } catch (error) {
      console.error('[Kafka Consumer] Failed to parse message:', error);
      return null;
    }
  }

  /**
   * Send failed message to dead-letter queue
   */
  async sendToDLQ(message, errorReason) {
    try {
      this.metrics.dlqMessages++;

      const dlqMessage = {
        key: message.key,
        value: message.value,
        headers: {
          ...message.headers,
          'x-error-reason': errorReason,
          'x-failed-timestamp': Date.now().toString(),
          'x-original-topic': config.kafka.topic,
        },
      };

      await this.dlqProducer.send({
        topic: config.kafka.dlqTopic,
        messages: [dlqMessage],
      });

      console.log(`[Kafka Consumer] Message sent to DLQ: ${errorReason}`);
    } catch (error) {
      console.error('[Kafka Consumer] Failed to send message to DLQ:', error);
      throw error;
    }
  }

  /**
   * Get consumer metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      isRunning: this.isRunning,
      isShuttingDown: this.isShuttingDown,
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      if (!this.isRunning) {
        return {
          status: 'unhealthy',
          reason: 'Consumer is not running',
        };
      }

      // Check if consumer is still processing messages
      const now = Date.now();
      const timeSinceLastMessage = this.metrics.lastProcessedTimestamp
        ? now - this.metrics.lastProcessedTimestamp
        : null;

      // Alert if no messages processed in last 5 minutes
      if (timeSinceLastMessage && timeSinceLastMessage > 300000) {
        return {
          status: 'degraded',
          reason: `No messages processed in ${Math.round(timeSinceLastMessage / 1000)}s`,
          metrics: this.metrics,
        };
      }

      return {
        status: 'healthy',
        metrics: this.metrics,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        reason: error.message,
      };
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.isShuttingDown) {
      console.log('[Kafka Consumer] Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    console.log('[Kafka Consumer] Shutting down gracefully...');

    try {
      // Stop consuming new messages
      if (this.consumer) {
        await this.consumer.disconnect();
        console.log('[Kafka Consumer] Consumer disconnected');
      }

      // Close DLQ producer
      if (this.dlqProducer) {
        await this.dlqProducer.disconnect();
        console.log('[Kafka Consumer] DLQ producer disconnected');
      }

      this.isRunning = false;
      console.log('[Kafka Consumer] Shutdown complete');
    } catch (error) {
      console.error('[Kafka Consumer] Error during shutdown:', error);
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new KafkaEventConsumer();
