# syntax=docker/dockerfile:1.7

# Build on the target platform: the pi-natives N-API addon is architecture-specific.
FROM oven/bun:1.4.4 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY scripts ./scripts
RUN bun run build \
	&& mkdir -p /empty-data

# Distroless ships glibc and CA certificates without a shell or package manager.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

COPY --from=build --chown=10001:10001 /empty-data /data
COPY --from=build --chown=10001:10001 /app/dist/omp-broker /usr/local/bin/omp-broker

ENV HOME=/data \
	OMP_BROKER_HOME=/data \
	OMP_BROKER_STORAGE=local \
	OMP_BROKER_DB=/data/auth.db \
	OMP_BROKER_BIND=0.0.0.0:4000

USER 10001:10001
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["omp-broker", "healthcheck"]

ENTRYPOINT ["omp-broker"]
CMD ["serve"]
