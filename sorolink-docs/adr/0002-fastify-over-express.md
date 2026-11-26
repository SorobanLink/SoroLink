# ADR-0002: Fastify over Express for the backend HTTP layer

**Status:** Accepted

**Date:** 2024-09-12

## Context

The SoroLink backend is a Node.js HTTP server. At the time of the initial
implementation, Express 4 was the most widely deployed Node.js framework,
but it had accumulated years of middleware that add implicit behaviour, and
its TypeScript support relies on community `@types` packages that sometimes
lag releases.

Fastify offered a schema-first request/response validation model using
JSON Schema, a plugin architecture that isolates concerns cleanly, and
first-class TypeScript support in its own type definitions. Its built-in
serializer and validator also gave measurable throughput improvements over
Express with JSON responses, which matters for the scenario-results endpoint
that returns large payloads.

## Decision

Use Fastify as the HTTP framework for `sorolink-backend`. All route handlers
declare request and reply JSON Schemas inline, and validation is enforced by
Fastify's Ajv integration before handler code runs.

## Consequences

### Positive
- Schema-validated request bodies at the framework layer with no manual
  `if (!body.field)` guards.
- First-party TypeScript types for plugin registration and route options.
- Higher throughput for JSON-heavy endpoints (scenario results, spec
  introspection).
- Plugin encapsulation (`fastify.register`) keeps route modules independent.

### Negative / trade-offs
- Contributors familiar with Express need to learn Fastify's plugin and
  lifecycle model.
- The Fastify ecosystem is smaller than Express's; some middleware has no
  direct equivalent and must be written from scratch.

### Neutral
- The JSON Schema definitions used for Fastify validation also serve as the
  source of truth for the OpenAPI spec export.

## Alternatives considered

| Alternative | Reason not chosen |
|-------------|-------------------|
| Express 4 | No built-in schema validation; slower JSON serialization |
| Hono | Mature ecosystem smaller; edge-first design not needed |
| Koa | Minimal; would require assembling validation middleware separately |
