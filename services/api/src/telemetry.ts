// @ts-nocheck
/**
 * OpenTelemetry instrumentation for Hermes API.
 * Traces HTTP requests, Redis calls, and PostgreSQL queries.
 *
 * Usage: import { tracer, otel } from './telemetry';
 *   tracer.startActiveSpan('my-operation', (span) => { ...; span.end(); });
 */

import { NodeSDK } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

const serviceName = process.env.OTEL_SERVICE_NAME ?? 'hermes-api';
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';

let sdk: NodeSDK | null = null;
let _tracer: any = null;

export function initTelemetry(): void {
  if (sdk) return;

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: '1.0.0',
  });

  const traceExporter = new OTLPTraceExporter({ url: otelEndpoint });

  const provider = new NodeTracerProvider({ resource });
  provider.addSpanProcessor(new BatchSpanProcessor(traceExporter));
  provider.register();

  // Auto-instrument common libraries
  const { DiagConsoleLogger, DiagLogLevel, diag } = require('@opentelemetry/api');
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  try {
    const { registerInstrumentations } = require('@opentelemetry/instrumentation');
    registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation({ ignoreIncomingPaths: ['/health', '/metrics'] }),
        new ExpressInstrumentation(),
        new IORedisInstrumentation({ dbStatementSerializer: (cmd: string, args: string[]) => `${cmd} ${args.join(' ')}` }),
        new PgInstrumentation(),
      ],
    });
  } catch (err) {
    console.warn('[telemetry] auto-instrumentation not available (packages not installed yet):', err instanceof Error ? err.message : String(err));
  }

  sdk = new NodeSDK({ resource, traceExporter });
  _tracer = provider.getTracer(serviceName);
  console.log(`[telemetry] OpenTelemetry initialized, exporting to ${otelEndpoint}`);
}

export function tracer(): any {
  return _tracer ?? {
    startActiveSpan: (_name: string, fn: (span: any) => void) => fn({ setAttribute: () => {}, end: () => {}, recordException: (e: Error) => console.error('[otel]', e) }),
  };
}

export const otel = {
  /**
   * Wrap an async function with a span. Propagates errors automatically.
   */
  trace<T>(name: string, fn: (span: any) => Promise<T>): Promise<T> {
    const t = tracer();
    return new Promise((resolve, reject) => {
      t.startActiveSpan(name, async (span: any) => {
        try {
          const result = await fn(span);
          span.end();
          resolve(result);
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: 2, message: String(err) });
          span.end();
          reject(err);
        }
      });
    });
  },

  /**
   * Add attributes to the current active span (no-op if no span).
   */
  addAttrs(attrs: Record<string, string | number | boolean>): void {
    const activeSpan = (globalThis as any).__hermes_active_span;
    if (activeSpan) {
      for (const [k, v] of Object.entries(attrs)) {
        activeSpan.setAttribute(k, v);
      }
    }
  },

  /**
   * Set the global active span (call from Express middleware).
   */
  setActiveSpan(span: any): void {
    (globalThis as any).__hermes_active_span = span;
  },
};

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    _tracer = null;
  }
}
