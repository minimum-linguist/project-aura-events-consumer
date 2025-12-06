#!/bin/bash

# Build Docker image for events-consumer-service
# Usage: ./scripts/build-image.sh [version]

set -e

# Get version from argument or use 'latest'
VERSION=${1:-latest}
IMAGE_NAME="project-aura-events-consumer"
FULL_IMAGE_NAME="${IMAGE_NAME}:${VERSION}"

echo "==============================================="
echo "Building ${FULL_IMAGE_NAME}"
echo "==============================================="

# Get git commit hash and build time
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build the image
docker build \
  --build-arg GIT_COMMIT="${GIT_COMMIT}" \
  --build-arg BUILD_TIME="${BUILD_TIME}" \
  -t "${FULL_IMAGE_NAME}" \
  -f Dockerfile \
  .

echo ""
echo "==============================================="
echo "Build complete!"
echo "Image: ${FULL_IMAGE_NAME}"
echo "Git commit: ${GIT_COMMIT}"
echo "Build time: ${BUILD_TIME}"
echo "==============================================="
echo ""
echo "To run locally:"
echo "  docker run -p 3003:3003 --env-file .env.example ${FULL_IMAGE_NAME}"
echo ""
echo "To tag for another registry:"
echo "  docker tag ${FULL_IMAGE_NAME} <registry>/${IMAGE_NAME}:${VERSION}"
