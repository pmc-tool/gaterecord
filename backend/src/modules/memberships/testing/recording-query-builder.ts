/**
 * Test-only: a chainable SelectQueryBuilder double that records every
 * where / andWhere condition (including those added to clones), so a spec can
 * assert how a service scoped its query without a database. Never imported by
 * application code.
 */
export interface RecordedCondition {
  sql: string;
  params: Record<string, unknown> | undefined;
}

export interface RecordingQueryBuilder {
  /** Every condition added through where/andWhere, on this builder or its clones. */
  readonly conditions: RecordedCondition[];
  /** The value of the first recorded parameter named `name`, or undefined. */
  param(name: string): unknown;
  /** Conditions whose SQL contains `fragment`. */
  matching(fragment: string): RecordedCondition[];
  /** The double itself, to hand to the service. */
  readonly qb: Record<string, jest.Mock>;
}

const CHAINABLE = [
  'select',
  'addSelect',
  'leftJoin',
  'leftJoinAndSelect',
  'innerJoin',
  'innerJoinAndSelect',
  'orderBy',
  'addOrderBy',
  'skip',
  'take',
  'limit',
  'offset',
  'groupBy',
];

export function recordingQueryBuilder(result: unknown[] = []): RecordingQueryBuilder {
  const conditions: RecordedCondition[] = [];

  const build = (): Record<string, jest.Mock> => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of CHAINABLE) {
      qb[method] = jest.fn(() => qb);
    }
    const record = jest.fn((sql: string, params?: Record<string, unknown>) => {
      conditions.push({ sql: String(sql), params });
      return qb;
    });
    qb.where = record;
    qb.andWhere = record;
    qb.clone = jest.fn(() => build());
    qb.getMany = jest.fn(async () => result);
    qb.getManyAndCount = jest.fn(async () => [result, result.length]);
    qb.getCount = jest.fn(async () => result.length);
    qb.getOne = jest.fn(async () => result[0] ?? null);
    return qb;
  };

  const qb = build();
  return {
    conditions,
    qb,
    param(name: string) {
      return conditions.find((c) => c.params && name in c.params)?.params?.[name];
    },
    matching(fragment: string) {
      return conditions.filter((c) => c.sql.includes(fragment));
    },
  };
}
