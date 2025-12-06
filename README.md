# Events Consumer Service

A dedicated Kafka consumer microservice that reads events from Kafka topics and writes them to MongoDB, completing the event streaming pipeline for Project Aura.

## Overview

This service consumes CloudEvents-formatted messages from Kafka and persists them to MongoDB with:
- **Idempotent writes** - Prevents duplicate events using event ID as MongoDB `_id`
- **Batch processing** - Optimized throughput with configurable batch sizes
- **Circuit breaker** - Protects MongoDB from cascading failures
- **Dead-letter queue** - Failed messages sent to DLQ topic for analysis
- **Horizontal scaling** - Multiple replicas in same consumer group
- **Health checks** - Kubernetes-ready liveness and readiness probes
- **Metrics** - Prometheus endpoints for monitoring

## Architecture

```
Backend API → Kafka (events-v1) → Consumer Service → MongoDB (events collection)
                                        ↓
                                  DLQ (events-v1-dlq)
```

### Key Components

- **Kafka Consumer** (`src/consumer/kafkaConsumer.js`) - Consumes from `events-v1` topic with consumer group `events-mongodb-writer`
- **MongoDB Writer** (`src/database/mongoWriter.js`) - Writes events to MongoDB with circuit breaker protection
- **Health Checks** (`src/index.js`) - HTTP server on port 3003 for `/health/*` endpoints
- **Metrics** (`src/metrics/prometheus.js`) - Prometheus metrics on port 9090

## Quick Start

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with actual Kafka and MongoDB connection details
   ```

3. **Run service:**
   ```bash
   npm start
   ```

### Docker

1. **Build image:**
   ```bash
   ./scripts/build-image.sh 1.0.0
   ```

2. **Run container:**
   ```bash
   docker run -p 3003:3003 --env-file .env project-aura-events-consumer:1.0.0
   ```

### Kubernetes

1. **Build and load image (for kind):**
   ```bash
   ./scripts/build-image.sh 1.0.0
   kind load docker-image project-aura-events-consumer:1.0.0 --name project-aura-dev
   ```

2. **Deploy to cluster:**
   ```bash
   ./scripts/deploy.sh
   ```

3. **Verify deployment:**
   ```bash
   kubectl get pods -l app=events-consumer
   kubectl logs -f deployment/events-consumer
   ```

## Configuration

Environment variables (see `.env.example` for full list):

| Variable | Default | Description |
|----------|---------|-------------|
| `KAFKA_BROKERS` | `kafka-service:9092` | Comma-separated Kafka broker addresses |
| `KAFKA_GROUP_ID` | `events-mongodb-writer` | Consumer group ID for coordination |
| `KAFKA_EVENTS_TOPIC` | `events-v1` | Main topic to consume from |
| `KAFKA_DLQ_TOPIC` | `events-v1-dlq` | Dead-letter queue topic |
| `MONGODB_URI` | - | MongoDB connection string (with credentials) |
| `MONGODB_DATABASE` | `projectaura` | Database name |
| `MONGODB_COLLECTION` | `events` | Collection name for events |
| `BATCH_SIZE` | `100` | Max events per batch write |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Circuit breaker failure threshold |

## Health Checks

- **Liveness:** `GET /health/live` - Is the service alive?
- **Readiness:** `GET /health/ready` - Is the service ready to process events?
- **Detailed:** `GET /health` - Full health status with component details

```bash
# Check health (requires port-forward)
kubectl port-forward service/events-consumer-service 3003:3003
curl http://localhost:3003/health
```

## Metrics

Prometheus metrics exposed on port 9090:

```bash
# View metrics (requires port-forward)
kubectl port-forward service/events-consumer-service 9090:9090
curl http://localhost:9090/metrics
```

**Key Metrics:**
- `kafka_messages_received_total` - Total messages received from Kafka
- `kafka_messages_processed_total` - Total messages successfully processed
- `kafka_messages_failed_total` - Total message processing failures
- `kafka_dlq_messages_total` - Total messages sent to DLQ
- `mongodb_writes_total` - Total MongoDB write attempts
- `mongodb_writes_successful_total` - Successful MongoDB writes
- `mongodb_duplicates_total` - Duplicate events skipped
- `mongodb_circuit_breaker_state` - Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)

## Monitoring

### View Logs

```bash
# All consumer pods
kubectl logs -l app=events-consumer

# Specific pod
kubectl logs events-consumer-<pod-id> -f

# Last 100 lines
kubectl logs deployment/events-consumer --tail=100
```

### Check Consumer Lag

```bash
# Exec into Kafka pod
kubectl exec -it kafka-0 -- bash

# Check consumer group lag
kafka-consumer-groups --bootstrap-server localhost:9092 --describe --group events-mongodb-writer
```

### Query MongoDB

```bash
# Check event count
kubectl exec mongodb-0 -- mongosh -u admin -p <password> --authenticationDatabase admin projectaura --eval "db.events.countDocuments()"

# View recent events
kubectl exec mongodb-0 -- mongosh -u admin -p <password> --authenticationDatabase admin projectaura --eval "db.events.find().sort({time:-1}).limit(5)"
```

## Scaling

The service supports horizontal scaling with multiple replicas:

```bash
# Scale to 3 replicas
kubectl scale deployment/events-consumer --replicas=3

# View replica distribution
kubectl get pods -l app=events-consumer -o wide
```

**Note:** Replicas automatically coordinate through Kafka consumer group rebalancing. Each replica will consume from different partitions.

## Troubleshooting

### Pods in CrashLoopBackOff

**Symptom:** Pods continually restart

**Common Causes:**
1. **MongoDB authentication failure** - Check `events-consumer-secrets` has correct `MONGODB_URI`
2. **Kafka connection failure** - Verify Kafka is running and accessible
3. **Missing secret** - Ensure `events-consumer-secrets` exists

**Fix:**
```bash
# Check logs for error
kubectl logs events-consumer-<pod-id>

# Update secret with correct MongoDB URI
kubectl delete secret events-consumer-secrets
kubectl create secret generic events-consumer-secrets \
  --from-literal=MONGODB_URI='mongodb://admin:password@mongodb-service:27017/projectaura?authSource=admin'

# Restart pods
kubectl delete pods -l app=events-consumer
```

### No Messages Being Processed

**Symptom:** `kafka_messages_received_total` metric stays at 0

**Checks:**
1. **Kafka topic exists** - Verify `events-v1` topic created
2. **Backend publishing** - Check backend is sending events to Kafka
3. **Consumer group** - Verify consumer group is subscribed

```bash
# List Kafka topics
kubectl exec kafka-0 -- kafka-topics --bootstrap-server localhost:9092 --list

# Check consumer groups
kubectl exec kafka-0 -- kafka-consumer-groups --bootstrap-server localhost:9092 --list
```

### Circuit Breaker OPEN

**Symptom:** `mongodb_circuit_breaker_state` = 2, no writes to MongoDB

**Cause:** MongoDB is unhealthy or connection is failing

**Fix:**
1. Check MongoDB health: `kubectl get pods | grep mongodb`
2. Test MongoDB connection from consumer pod
3. Circuit breaker will automatically retry after timeout (30s by default)

## Development

### Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Watch mode
npm run test:watch
```

### Code Quality

```bash
# Lint code
npm run lint

# Fix lint issues
npm run lint:fix

# Format code
npm run format
```

## Related Documentation

- [Phase 1.5 Implementation Guide](../project-aura-docs/guides/PHASE-1-IMPLEMENTATION-GUIDE.md)
- [ADR-0034: Kafka Event Streaming Integration](../project-aura-docs/architecture/decisions/ADR-0034-kafka-event-streaming.md)
- [CloudEvents Specification](https://cloudevents.io/)
- [Testing Strategy](../project-aura-docs/guides/TESTING-STRATEGY.md)

## Support

For issues or questions:
- Check logs: `kubectl logs deployment/events-consumer`
- Review metrics: `http://localhost:9090/metrics`
- View health status: `http://localhost:3003/health`
