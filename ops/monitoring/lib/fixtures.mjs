// Test data of the monitoring validation: secrets made fresh on every run (nothing in this file is a credential), the
// API's closed list of attributes, and OTLP/JSON payloads shaped like the API's own export
// (apps/api/src/telemetry/sdk.ts), once as the API sends it and once with attributes added that the API would never
// record.
import { randomBytes } from "node:crypto";

export const secret = (bytes = 24) => randomBytes(bytes).toString("base64url");

/**
 * The attribute keys the API may record on a data point (`ATTRIBUTE_RULES` in apps/api/src/telemetry/attributes.ts) and
 * on its resource (`RESOURCE_KEYS`). `apps/api/src/telemetry/monitoring.test.ts` keeps both lists equal to the code's.
 * Prometheus cannot filter what it is sent (ADR-626), so these lists are what the validation and the RUNBOOK's label
 * audit compare the stored labels with.
 */
export const DATAPOINT_KEYS = [
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "questify.route_class",
  "questify.event",
  "questify.log.level",
  "questify.operation",
  "questify.provider",
  "questify.outcome",
  "questify.tick",
  "questify.pool",
  "questify.pool.state",
];
export const RESOURCE_KEYS = [
  "service.name",
  "service.version",
  "service.instance.id",
  "deployment.environment.name",
];

const toLabel = (key) => key.replaceAll(".", "_");

/**
 * Every label name a stored series of the API may carry: its data point attributes, `__name__`, `job` and `instance`
 * (from `service.name` and `service.instance.id`), and `le` on histogram buckets.
 */
export const SERIES_LABELS = [...DATAPOINT_KEYS.map(toLabel), "__name__", "job", "instance", "le"];

/** Every label name of the API's `target_info` series: the two resource attributes that are not `job` or `instance`. */
export const TARGET_INFO_LABELS = [
  "__name__",
  "job",
  "instance",
  ...RESOURCE_KEYS.filter((key) => key !== "service.name" && key !== "service.instance.id").map(
    toLabel,
  ),
];

/** Values a test person or address would have, which must never be stored. */
export const FORBIDDEN = {
  keys: ["user.email", "client.address", "url.full", "host.name"],
  values: [
    "person@example.test",
    "203.0.113.9",
    "https://example.test/v1/players/someone",
    "laptop-7",
  ],
};

const text = (key, value) => ({ key, value: { stringValue: value } });

const resource = (instance, job, offList) => ({
  attributes: [
    text("service.name", job),
    text("service.version", "validate"),
    text("service.instance.id", instance),
    text("deployment.environment.name", "validation"),
    ...(offList
      ? [text("host.name", FORBIDDEN.values[3]), text("user.email", FORBIDDEN.values[0])]
      : []),
  ],
});

const offListOnPoints = [
  text("user.email", FORBIDDEN.values[0]),
  text("client.address", FORBIDDEN.values[1]),
  text("url.full", FORBIDDEN.values[2]),
];

const point = (attributes, offList, extra) => ({
  attributes: [...attributes, ...(offList ? offListOnPoints : [])],
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
function metricsOf(offList) {
  const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10];
  const counts = [0, 0, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0, 0];
  return [
    {
      name: "http.server.request.duration",
      unit: "s",
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [
          point(requestAttributes(200, "completion"), offList, {
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
          point(
            [text("questify.event", "database.busy"), text("questify.log.level", "warn")],
            offList,
            { asDouble: 2 },
          ),
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
            offList,
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
          point([text("questify.tick", "ranking_repair")], offList, {
            asDouble: Date.now() / 1000,
          }),
        ],
      },
    },
  ];
}

/**
 * The metrics of one API instance, as the API sends them. With `offList` they also carry attributes the API never
 * records (on the resource and on every data point), and the scope has one. `job` is the resource's `service.name`.
 */
export function metricsPayload(instance, { job = "questify-api", offList = false } = {}) {
  const scope = {
    name: "questify-api",
    ...(offList ? { attributes: [text("scope.secret", "kept?")] } : {}),
  };
  return {
    resourceMetrics: [
      {
        resource: resource(instance, job, offList),
        scopeMetrics: [{ scope, metrics: metricsOf(offList) }],
      },
    ],
  };
}
