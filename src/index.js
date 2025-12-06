/**
 * Event Consumer Service
 *
 * Main application entry point for the Kafka-to-MongoDB event consumer service.
 * Provides health checks, metrics, and graceful shutdown handling.
 *
 * Related: ADR-0034 (Kafka Event Streaming Integration)
 */

const express = require('express');
const config = require('./config');
const kafkaConsumer = require('./consumer/kafkaConsumer');
const mongoWriter = require('./database/mongoWriter');
const { getMetrics } = require('./metrics/prometheus');

const app = express();

// Middleware
app.use(express.json());

/**
 * Health check endpoints
 */

// Liveness probe - is the service alive?
app.get('/health/live', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe - is the service ready to handle requests?
app.get('/health/ready', async (req, res) => {
  try {
    const mongoHealth = await mongoWriter.healthCheck();
    const consumerHealth = await kafkaConsumer.healthCheck();

    const isReady =
      mongoHealth.status === 'healthy' &&
      (consumerHealth.status === 'healthy' || consumerHealth.status === 'degraded');

    if (isReady) {
      res.status(200).json({
        status: 'ready',
        mongodb: mongoHealth,
        consumer: consumerHealth,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(503).json({
        status: 'not ready',
        mongodb: mongoHealth,
        consumer: consumerHealth,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    res.status(503).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Detailed health check
app.get('/health', async (req, res) => {
  try {
    const mongoHealth = await mongoWriter.healthCheck();
    const consumerHealth = await kafkaConsumer.healthCheck();

    const overallStatus =
      mongoHealth.status === 'healthy' && consumerHealth.status === 'healthy'
        ? 'healthy'
        : mongoHealth.status === 'unhealthy' || consumerHealth.status === 'unhealthy'
        ? 'unhealthy'
        : 'degraded';

    res.status(overallStatus === 'healthy' ? 200 : 503).json({
      status: overallStatus,
      components: {
        mongodb: mongoHealth,
        consumer: consumerHealth,
      },
      config: {
        kafka: {
          brokers: config.kafka.brokers,
          topic: config.kafka.topic,
          groupId: config.kafka.groupId,
        },
        mongodb: {
          database: config.mongodb.database,
          collection: config.mongodb.collection,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Metrics endpoint
 */
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    console.error('[Metrics] Failed to generate metrics:', error);
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

/**
 * Service info endpoint
 */
app.get('/', (req, res) => {
  res.json({
    service: 'events-consumer-service',
    version: '1.0.0',
    description: 'Kafka event consumer service that writes events to MongoDB',
    endpoints: {
      health: {
        live: '/health/live',
        ready: '/health/ready',
        detailed: '/health',
      },
      metrics: '/metrics',
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Start the service
 */
async function start() {
  try {
    console.log('[Service] Starting Event Consumer Service...');
    console.log('[Service] Environment:', config.env);
    console.log('[Service] Kafka Brokers:', config.kafka.brokers.join(', '));
    console.log('[Service] Kafka Topic:', config.kafka.topic);
    console.log('[Service] Kafka Group ID:', config.kafka.groupId);
    console.log('[Service] MongoDB Database:', config.mongodb.database);
    console.log('[Service] MongoDB Collection:', config.mongodb.collection);

    // Initialize MongoDB connection
    console.log('[Service] Connecting to MongoDB...');
    await mongoWriter.initialize();
    console.log('[Service] MongoDB connected');

    // Initialize Kafka consumer
    console.log('[Service] Initializing Kafka consumer...');
    await kafkaConsumer.initialize();
    console.log('[Service] Kafka consumer initialized');

    // Start HTTP server for health checks
    const server = app.listen(config.port, () => {
      console.log(`[Service] HTTP server listening on port ${config.port}`);
      console.log(`[Service] Health check: http://localhost:${config.port}/health`);
      console.log(`[Service] Metrics: http://localhost:${config.port}/metrics`);
    });

    // Start consuming messages
    console.log('[Service] Starting message consumption...');
    await kafkaConsumer.start();

    console.log('[Service] Service started successfully!');

    // Graceful shutdown handlers
    const shutdown = async (signal) => {
      console.log(`\n[Service] Received ${signal}, starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        console.log('[Service] HTTP server closed');
      });

      try {
        // Shutdown Kafka consumer
        await kafkaConsumer.shutdown();

        // Close MongoDB connection
        await mongoWriter.close();

        console.log('[Service] Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('[Service] Error during shutdown:', error);
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('[Service] Uncaught exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[Service] Unhandled rejection at:', promise, 'reason:', reason);
      shutdown('unhandledRejection');
    });

  } catch (error) {
    console.error('[Service] Failed to start service:', error);
    process.exit(1);
  }
}

// Start the service
if (require.main === module) {
  start();
}

module.exports = { app, start };
