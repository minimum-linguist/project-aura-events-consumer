/**
 * Configuration Module
 *
 * Loads and validates environment configuration for the consumer service.
 */

require('dotenv').config();

const config = {
  // Service Configuration
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3003', 10),

  // Kafka Configuration
  kafka: {
    brokers: process.env.KAFKA_BROKERS?.split(',') || ['kafka-service:9092'],
    clientId: process.env.KAFKA_CLIENT_ID || 'project-aura-events-consumer',
    groupId: process.env.KAFKA_GROUP_ID || 'events-mongodb-writer',
    topic: process.env.KAFKA_EVENTS_TOPIC || 'events-v1',
    dlqTopic: process.env.KAFKA_DLQ_TOPIC || 'events-v1-dlq',

    // Consumer-specific settings
    consumer: {
      sessionTimeout: parseInt(process.env.CONSUMER_SESSION_TIMEOUT || '30000', 10),
      heartbeatInterval: parseInt(process.env.CONSUMER_HEARTBEAT_INTERVAL || '3000', 10),
      maxBytesPerPartition: parseInt(process.env.CONSUMER_MAX_BYTES_PER_PARTITION || '1048576', 10),
      autoCommit: process.env.CONSUMER_AUTO_COMMIT !== 'false',
      autoCommitInterval: parseInt(process.env.CONSUMER_AUTO_COMMIT_INTERVAL || '5000', 10),
    },
  },

  // MongoDB Configuration
  mongodb: {
    uri:
      process.env.MONGODB_URI ||
      'mongodb://admin:password@mongodb-service:27017/projectaura?authSource=admin',
    database: process.env.MONGODB_DATABASE || 'projectaura',
    collection: process.env.MONGODB_COLLECTION || 'events',
  },

  // Batch Processing
  batch: {
    size: parseInt(process.env.BATCH_SIZE || '100', 10),
    timeoutMs: parseInt(process.env.BATCH_TIMEOUT_MS || '5000', 10),
  },

  // Circuit Breaker Configuration
  circuitBreaker: {
    failureThreshold: parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD || '5', 10),
    successThreshold: parseInt(process.env.CIRCUIT_SUCCESS_THRESHOLD || '2', 10),
    timeoutMs: parseInt(process.env.CIRCUIT_TIMEOUT_MS || '30000', 10),
  },

  // Retry Configuration
  retry: {
    initialDelay: parseInt(process.env.RETRY_INITIAL_DELAY || '1000', 10),
    maxDelay: parseInt(process.env.RETRY_MAX_DELAY || '30000', 10),
    maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3', 10),
    backoffMultiplier: parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER || '2'),
  },

  // Monitoring
  metrics: {
    enabled: process.env.ENABLE_METRICS !== 'false',
    port: parseInt(process.env.METRICS_PORT || '9090', 10),
  },
};

/**
 * Validate required configuration
 */
function validateConfig() {
  const errors = [];

  if (!config.kafka.brokers || config.kafka.brokers.length === 0) {
    errors.push('KAFKA_BROKERS must be configured');
  }

  if (!config.mongodb.uri) {
    errors.push('MONGODB_URI must be configured');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return true;
}

// Validate on load
validateConfig();

module.exports = config;
