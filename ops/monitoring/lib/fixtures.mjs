// Test data of the monitoring validation: secrets made fresh on every run (nothing in this file is a credential), and
// OTLP/JSON payloads shaped like the API's own export (apps/api/src/telemetry/sdk.ts) with attributes added that the
// API would never record, to prove the collector removes them.
import { randomBytes } from "node:crypto";

export const secret = (bytes = 24) => randomBytes(bytes).toString("base64url");

/** Values a test person or address would have, which must never come out of the collector. */
export const FORBIDDEN = {
  keys: [
    "user.email",
    "client.address",
    "url.full",
    "host.name",
    "enduser.id",
    "exception.message",
  ],
  values: [
    "person@example.test",
    "203.0.113.9",
    "https://example.test/v1/players/someone",
    "laptop-7",
  ],
};

const text = (key, value) => ({ key, value: { stringValue: value } });

const resource = (instance) => ({
  attributes: [
    text("service.name", "questify-api"),
    text("service.version", "validate"),
    text("service.instance.id", instance),
    text("deployment.environment.name", "validation"),
    text("host.name", FORBIDDEN.values[3]),
    text("user.email", FORBIDDEN.values[0]),
  ],
});

const forbiddenOnPoints = [
  text("user.email", FORBIDDEN.values[0]),
  text("client.address", FORBIDDEN.values[1]),
  text("url.full", FORBIDDEN.values[2]),
];

const point = (attributes, extra) => ({
  attributes: [...attributes, ...forbiddenOnPoints],
  startTimeUnixNano: `${Date.now() - 60_000}000000`,
  timeUnixNano: `${Date.now()}000000`,
  ...extra,
});

const requestAttributes = (status, routeClass) => [
  text("http.request.method", "GET"),
  text("http.route", "/v1/health"),
  { key: "http.response.status_code", value: { intValue: status } },
  text("questify.route_class", routeClass),
];

/** One metric of each kind the API records: a histogram, two counters and a gauge. */
export function metricsPayload(instance) {
  const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10];
  const counts = [0, 0, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0, 0];
  const metrics = [
    {
      name: "http.server.request.duration",
      unit: "s",
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [
          point(requestAttributes(200, "completion"), {
            count: 4,
            sum: 0.9,
            bucketCounts: counts,
            explicitBounds: bounds,
          }),
        ],
      },
    },
    {
      name: "questify.log.events",
      unit: "{event}",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          point([text("questify.event", "database.busy"), text("questify.log.level", "warn")], {
            asDouble: 2,
          }),
        ],
      },
    },
    {
      name: "questify.outbound.requests",
      unit: "{request}",
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          point(
            [
              text("questify.operation", "sms"),
              text("questify.provider", "msegat"),
              text("questify.outcome", "sent"),
            ],
            { asDouble: 5 },
          ),
        ],
      },
    },
    {
      name: "questify.tick.last_run",
      unit: "s",
      gauge: {
        dataPoints: [
          point([text("questify.tick", "ranking_repair")], { asDouble: Date.now() / 1000 }),
        ],
      },
    },
  ];
  return {
    resourceMetrics: [
      {
        resource: resource(instance),
        scopeMetrics: [
          { scope: { name: "questify-api", attributes: [text("scope.secret", "kept?")] }, metrics },
        ],
      },
    ],
  };
}

/** A span with an event and a status message, the two places free text could hide. */
export function tracesPayload(instance) {
  const now = Date.now();
  return {
    resourceSpans: [
      {
        resource: resource(instance),
        scopeSpans: [
          {
            scope: { name: "questify-api" },
            spans: [
              {
                traceId: randomBytes(16).toString("hex"),
                spanId: randomBytes(8).toString("hex"),
                name: "GET /v1/health",
                kind: 2,
                startTimeUnixNano: `${now - 5}000000`,
                endTimeUnixNano: `${now}000000`,
                attributes: [
                  text("http.route", "/v1/health"),
                  { key: "http.response.status_code", value: { intValue: 500 } },
                  ...forbiddenOnPoints,
                ],
                events: [
                  {
                    name: "exception",
                    timeUnixNano: `${now}000000`,
                    attributes: [text("exception.message", FORBIDDEN.values[0])],
                  },
                ],
                status: { code: 2, message: FORBIDDEN.values[0] },
              },
            ],
          },
        ],
      },
    ],
  };
}
