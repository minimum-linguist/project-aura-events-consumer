/**
 * Prometheus Metrics
 *
 * Exposes metrics for monitoring consumer performance:
 * - Messages received/processed/failed
 * - Consumer lag
 * - MongoDB write performance
 * - Circuit breaker state
 */

const client = require('prom-client');
const config = require('../config');
const kafkaConsumer = require('../consumer/kafkaConsumer');
const mongoWriter = require('../database/mongoWriter');

// Create a Registry
const register = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Custom metrics
const metrics = {
  // Kafka Consumer Metrics
  messagesReceived: new client.Counter({
    name: 'kafka_messages_received_total',
    help: 'Total number of messages received from Kafka',
    registers: [register],
  }),

  messagesProcessed: new client.Counter({
    name: 'kafka_messages_processed_total',
    help: 'Total number of messages successfully processed',
    registers: [register],
  }),

  messagesFailed: new client.Counter({
    name: 'kafka_messages_failed_total',
    help: 'Total number of messages that failed processing',
    registers: [register],
  }),

  dlqMessages: new client.Counter({
    name: 'kafka_dlq_messages_total',
    help: 'Total number of messages sent to dead-letter queue',
    registers: [register],
  }),

  batchesProcessed: new client.Counter({
    name: 'kafka_batches_processed_total',
    help: 'Total number of batches processed',
    registers: [register],
  }),

  messageProcessingDuration: new client.Histogram({
    name: 'kafka_message_processing_duration_seconds',
    help: 'Time to process a single message',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
  }),

  consumerLag: new client.Gauge({
    name: 'kafka_consumer_lag',
    help: 'Consumer lag (messages behind)',
    registers: [register],
  }),

  // MongoDB Writer Metrics
  mongoWrites: new client.Counter({
    name: 'mongodb_writes_total',
    help: 'Total number of MongoDB write attempts',
    registers: [register],
  }),

  mongoWritesSuccessful: new client.Counter({
    name: 'mongodb_writes_successful_total',
    help: 'Total number of successful MongoDB writes',
    registers: [register],
  }),

  mongoWritesFailed: new client.Counter({
    name: 'mongodb_writes_failed_total',
    help: 'Total number of failed MongoDB writes',
    registers: [register],
  }),

  mongoDuplicates: new client.Counter({
    name: 'mongodb_duplicates_total',
    help: 'Total number of duplicate events skipped',
    registers: [register],
  }),

  mongoBatchWrites: new client.Counter({
    name: 'mongodb_batch_writes_total',
    help: 'Total number of batch writes to MongoDB',
    registers: [register],
  }),

  mongoWriteDuration: new client.Histogram({
    name: 'mongodb_write_duration_seconds',
    help: 'Time to write to MongoDB',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
  }),

  mongoCircuitState: new client.Gauge({
    name: 'mongodb_circuit_breaker_state',
    help: 'Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
    registers: [register],
  }),

  // Service Health
  consumerRunning: new client.Gauge({
    name: 'consumer_running',
    help: 'Whether the consumer is currently running (1=yes, 0=no)',
    registers: [register],
  }),

  mongoConnected: new client.Gauge({
    name: 'mongodb_connected',
    help: 'Whether MongoDB is connected (1=yes, 0=no)',
    registers: [register],
  }),
};

/**
 * Update metrics from service components
 */
function updateMetrics() {
  // Get consumer metrics
  const consumerMetrics = kafkaConsumer.getMetrics();
  metrics.consumerRunning.set(consumerMetrics.isRunning ? 1 : 0);
  metrics.consumerLag.set(consumerMetrics.consumerLag || 0);

  // Get MongoDB writer metrics
  const writerMetrics = mongoWriter.getMetrics();
  metrics.mongoConnected.set(writerMetrics.isConnected ? 1 : 0);

  // Map circuit state to number
  const circuitStateMap = {
    CLOSED: 0,
    HALF_OPEN: 1,
    OPEN: 2,
  };
  metrics.mongoCircuitState.set(circuitStateMap[writerMetrics.circuitState] || 0);
}

/**
 * Get metrics in Prometheus format
 */
async function getMetrics() {
  updateMetrics();
  return register.metrics();
}

/**
 * Get metrics register
 */
function getRegister() {
  return register;
}

module.exports = {
  metrics,
  getMetrics,
  getRegister,
  updateMetrics,
};
