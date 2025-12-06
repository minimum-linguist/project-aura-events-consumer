#!/bin/bash

# Deploy events-consumer service to Kubernetes
# Usage: ./scripts/deploy.sh [environment]

set -e

ENVIRONMENT=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$(cd "${SCRIPT_DIR}/../k8s" && pwd)"

echo "==============================================="
echo "Deploying Events Consumer Service"
echo "Environment: ${ENVIRONMENT}"
echo "==============================================="

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "Error: kubectl is not installed or not in PATH"
    exit 1
fi

# Check if cluster is accessible
if ! kubectl cluster-info &> /dev/null; then
    echo "Error: Cannot connect to Kubernetes cluster"
    exit 1
fi

echo ""
echo "Step 1: Creating ConfigMap..."
kubectl apply -f "${K8S_DIR}/configmap.yaml"

echo ""
echo "Step 2: Creating/Updating Secret..."
echo "⚠️  Note: Secret must be created manually with actual MongoDB credentials"
echo "    Use: kubectl create secret generic events-consumer-secrets \\"
echo "           --from-literal=MONGODB_URI='mongodb://admin:password@mongodb-service:27017/projectaura?authSource=admin'"
echo ""

# Check if secret exists
if ! kubectl get secret events-consumer-secrets &> /dev/null; then
    echo "⚠️  Secret 'events-consumer-secrets' does not exist!"
    echo "    Creating a temporary secret for testing purposes..."
    echo "    REPLACE THIS WITH ACTUAL CREDENTIALS IN PRODUCTION!"

    # Get MongoDB password from existing secret if available
    MONGODB_PASSWORD=$(kubectl get secret mongodb-secret -o jsonpath='{.data.mongodb-root-password}' 2>/dev/null | base64 -d || echo "password")
    MONGODB_URI="mongodb://admin:${MONGODB_PASSWORD}@mongodb-service.default.svc.cluster.local:27017/projectaura?authSource=admin"

    kubectl create secret generic events-consumer-secrets \
        --from-literal=MONGODB_URI="${MONGODB_URI}"
    echo "✓ Temporary secret created"
else
    echo "✓ Secret 'events-consumer-secrets' already exists"
fi

echo ""
echo "Step 3: Deploying Service..."
kubectl apply -f "${K8S_DIR}/service.yaml"

echo ""
echo "Step 4: Deploying Application..."
kubectl apply -f "${K8S_DIR}/deployment.yaml"

echo ""
echo "==============================================="
echo "Deployment initiated!"
echo "==============================================="
echo ""
echo "Checking deployment status..."
kubectl rollout status deployment/events-consumer --timeout=120s

echo ""
echo "==============================================="
echo "Deployment Status"
echo "==============================================="
kubectl get deployment events-consumer
kubectl get pods -l app=events-consumer
kubectl get service events-consumer-service

echo ""
echo "==============================================="
echo "Useful Commands"
echo "==============================================="
echo "View logs:"
echo "  kubectl logs -f deployment/events-consumer"
echo ""
echo "Check health:"
echo "  kubectl port-forward service/events-consumer-service 3003:3003"
echo "  curl http://localhost:3003/health"
echo ""
echo "View metrics:"
echo "  kubectl port-forward service/events-consumer-service 9090:9090"
echo "  curl http://localhost:9090/metrics"
echo ""
echo "Scale replicas:"
echo "  kubectl scale deployment/events-consumer --replicas=3"
echo ""
echo "Delete deployment:"
echo "  kubectl delete -f ${K8S_DIR}/deployment.yaml"
echo "  kubectl delete -f ${K8S_DIR}/service.yaml"
echo "  kubectl delete -f ${K8S_DIR}/configmap.yaml"
echo ""
