FROM postgres:17

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates

COPY ./initdb/001_extensions.sql /docker-entrypoint-initdb.d/001_extensions.sql

CMD ["postgres", "-c", "shared_preload_libraries=timescaledb"]
