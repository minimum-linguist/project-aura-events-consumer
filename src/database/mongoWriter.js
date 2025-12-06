/**
 * MongoDB Writer
 *
 * Handles writing events from Kafka to MongoDB with:
 * - Idempotent writes (using event ID as _id)
 * - Batch processing for performance
 * - Circuit breaker for failure protection
 * - Retry logic with exponential backoff
 * - Dead-letter queue for failed events
 *
 * Related: ADR-0034 (Kafka Event Streaming Integration)
 */

const { MongoClient } = require('mongodb');
const config = require('../config');

/**
 * Circuit breaker states
 */
const CircuitState = {
  CLOSED: 'CLOSED', // Normal operation
  OPEN: 'OPEN', // Failing, reject requests immediately
  HALF_OPEN: 'HALF_OPEN', // Testing if service recovered
};

/**
 * MongoDB Writer Class
 */
class MongoDBWriter {
  constructor() {
    this.client = null;
    this.db = null;
    this.collection = null;
    this.isConnected = false;
    this.isConnecting = false;

    // Circuit breaker state
    this.circuitState = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;

    // Metrics
    this.metrics = {
      totalWrites: 0,
      successfulWrites: 0,
      failedWrites: 0,
      duplicateWrites: 0,
      batchWrites: 0,
    };
  }

  /**
   * Initialize MongoDB connection
   */
  async initialize() {
    if (this.isConnected) {
      return;
    }

    if (this.isConnecting) {
      // Wait for existing connection attempt
      while (this.isConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.isConnecting = true;

    try {
      console.log('[MongoDB Writer] Connecting to MongoDB...');

      const clientOptions = {
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 60000,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        retryWrites: true,
        retryReads: true,
      };

      this.client = new MongoClient(config.mongodb.uri, clientOptions);
      await this.client.connect();

      // Verify connection
      await this.client.db('admin').command({ ping: 1 });

      this.db = this.client.db(config.mongodb.database);
      this.collection = this.db.collection(config.mongodb.collection);

      // Create indexes for performance
      await this.createIndexes();

      this.isConnected = true;
      this.isConnecting = false;

      console.log(
        `[MongoDB Writer] Successfully connected to ${config.mongodb.database}.${config.mongodb.collection}`
      );
    } catch (error) {
      this.isConnecting = false;
      console.error('[MongoDB Writer] Failed to connect:', error);
      throw error;
    }
  }

  /**
   * Create necessary indexes
   */
  async createIndexes() {
    try {
      // Index on timestamp for time-based queries
      await this.collection.createIndex({ time: -1 });

      // Index on type for filtering
      await this.collection.createIndex({ type: 1 });

      // Index on source for filtering
      await this.collection.createIndex({ source: 1 });

      // Compound index for common queries
      await this.collection.createIndex({ time: -1, type: 1 });

      console.log('[MongoDB Writer] Indexes created successfully');
    } catch (error) {
      console.error('[MongoDB Writer] Failed to create indexes:', error);
      // Don't throw - indexes are optional for functionality
    }
  }

  /**
   * Check if circuit breaker allows requests
   */
  canExecute() {
    if (this.circuitState === CircuitState.CLOSED) {
      return true;
    }

    if (this.circuitState === CircuitState.OPEN) {
      const now = Date.now();
      const timeSinceLastFailure = now - this.lastFailureTime;

      if (timeSinceLastFailure >= config.circuitBreaker.timeoutMs) {
        console.log('[MongoDB Writer] Circuit breaker entering HALF_OPEN state');
        this.circuitState = CircuitState.HALF_OPEN;
        this.successCount = 0;
        return true;
      }

      return false;
    }

    // HALF_OPEN state - allow requests
    return true;
  }

  /**
   * Record successful operation
   */
  recordSuccess() {
    this.failureCount = 0;

    if (this.circuitState === CircuitState.HALF_OPEN) {
      this.successCount++;

      if (this.successCount >= config.circuitBreaker.successThreshold) {
        console.log('[MongoDB Writer] Circuit breaker closing after successful operations');
        this.circuitState = CircuitState.CLOSED;
        this.successCount = 0;
      }
    }
  }

  /**
   * Record failed operation
   */
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.circuitState === CircuitState.HALF_OPEN) {
      console.log('[MongoDB Writer] Circuit breaker reopening after failure in HALF_OPEN state');
      this.circuitState = CircuitState.OPEN;
      return;
    }

    if (this.failureCount >= config.circuitBreaker.failureThreshold) {
      console.log(`[MongoDB Writer] Circuit breaker opening after ${this.failureCount} failures`);
      this.circuitState = CircuitState.OPEN;
    }
  }

  /**
   * Write a single event to MongoDB
   * @param {Object} event - CloudEvent to write
   * @returns {Promise<Object>} Write result
   */
  async writeEvent(event) {
    if (!this.canExecute()) {
      throw new Error('Circuit breaker is OPEN - MongoDB writes are temporarily disabled');
    }

    try {
      this.metrics.totalWrites++;

      // Use event ID as MongoDB _id for idempotency
      const document = {
        _id: event.id,
        ...event,
      };

      // Upsert to handle duplicates gracefully
      const result = await this.collection.updateOne(
        { _id: document._id },
        { $setOnInsert: document },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        this.metrics.successfulWrites++;
        this.recordSuccess();
        return { success: true, inserted: true, eventId: event.id };
      } else {
        // Document already exists (duplicate)
        this.metrics.duplicateWrites++;
        this.recordSuccess();
        return { success: true, inserted: false, eventId: event.id, duplicate: true };
      }
    } catch (error) {
      this.metrics.failedWrites++;
      this.recordFailure();
      console.error('[MongoDB Writer] Failed to write event:', error);
      throw error;
    }
  }

  /**
   * Write multiple events in a batch
   * @param {Array<Object>} events - Array of CloudEvents to write
   * @returns {Promise<Object>} Batch write result
   */
  async writeBatch(events) {
    if (!this.canExecute()) {
      throw new Error('Circuit breaker is OPEN - MongoDB writes are temporarily disabled');
    }

    if (!events || events.length === 0) {
      return { success: true, inserted: 0, duplicates: 0, failed: 0 };
    }

    try {
      this.metrics.totalWrites += events.length;
      this.metrics.batchWrites++;

      // Prepare bulk operations
      const operations = events.map((event) => ({
        updateOne: {
          filter: { _id: event.id },
          update: { $setOnInsert: { _id: event.id, ...event } },
          upsert: true,
        },
      }));

      // Execute bulk write
      const result = await this.collection.bulkWrite(operations, { ordered: false });

      const inserted = result.upsertedCount || 0;
      const duplicates = events.length - inserted;

      this.metrics.successfulWrites += inserted;
      this.metrics.duplicateWrites += duplicates;

      this.recordSuccess();

      console.log(
        `[MongoDB Writer] Batch write complete: ${inserted} inserted, ${duplicates} duplicates`
      );

      return {
        success: true,
        inserted,
        duplicates,
        failed: 0,
        total: events.length,
      };
    } catch (error) {
      this.metrics.failedWrites += events.length;
      this.recordFailure();
      console.error('[MongoDB Writer] Batch write failed:', error);
      throw error;
    }
  }

  /**
   * Write event with retry logic
   * @param {Object} event - CloudEvent to write
   * @param {number} attempt - Current attempt number
   * @returns {Promise<Object>} Write result
   */
  async writeEventWithRetry(event, attempt = 1) {
    try {
      return await this.writeEvent(event);
    } catch (error) {
      if (attempt >= config.retry.maxAttempts) {
        console.error(`[MongoDB Writer] Event write failed after ${attempt} attempts:`, error);
        throw error;
      }

      const delay = Math.min(
        config.retry.initialDelay * Math.pow(config.retry.backoffMultiplier, attempt - 1),
        config.retry.maxDelay
      );

      console.log(
        `[MongoDB Writer] Retrying event write (attempt ${attempt + 1}/${config.retry.maxAttempts}) after ${delay}ms`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.writeEventWithRetry(event, attempt + 1);
    }
  }

  /**
   * Get current metrics
   * @returns {Object} Current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      circuitState: this.circuitState,
      isConnected: this.isConnected,
    };
  }

  /**
   * Health check
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      if (!this.isConnected) {
        return {
          status: 'unhealthy',
          reason: 'Not connected to MongoDB',
        };
      }

      // Ping MongoDB
      await this.client.db('admin').command({ ping: 1 });

      return {
        status: 'healthy',
        circuitState: this.circuitState,
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
   * Close MongoDB connection
   */
  async close() {
    if (this.client) {
      console.log('[MongoDB Writer] Closing connection...');
      await this.client.close();
      this.isConnected = false;
      this.client = null;
      this.db = null;
      this.collection = null;
      console.log('[MongoDB Writer] Connection closed');
    }
  }
}

// Export singleton instance
module.exports = new MongoDBWriter();
