import { describe, it, expect } from 'vitest'
import { getEventListeners } from 'node:events'
import { all, allSettled, flow } from './index'

/**
 * Stress and regression-guard tests.
 *
 * These lock in the *current* observable behavior of `all`, `allSettled` and
 * `flow` under load and pathological graph shapes, so that future
 * optimizations cannot silently introduce quadratic behavior, listener leaks
 * or stack overflows. They are written to be tolerant of slow CI machines:
 * generous wall-clock budgets and no sub-millisecond timing assertions.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A small (7 task) dependency graph reused by the repetition tests. */
function buildSmallGraph() {
  return {
    a: () => 1,
    b: () => 2,
    c: async function (this: any) {
      return (await this.$.a) + 10
    },
    d: async function (this: any) {
      return (await this.$.b) * 10
    },
    e: async function (this: any) {
      return (await this.$.c) + (await this.$.d)
    },
    f: async function (this: any) {
      return (await this.$.e) + 1
    },
    g: async function (this: any) {
      return [await this.$.a, await this.$.b, await this.$.f]
    },
  }
}

const SMALL_GRAPH_EXPECTED = {
  a: 1,
  b: 2,
  c: 11,
  d: 20,
  e: 31,
  f: 32,
  g: [1, 2, 32],
}

/** A flow graph whose last task ends the flow with a deterministic value. */
function buildFlowGraph() {
  return {
    a: () => 1,
    b: async function (this: any) {
      return (await this.$.a) + 1
    },
    c: async function (this: any) {
      return (await this.$.b) + 1
    },
    d: async function (this: any) {
      this.$end((await this.$.c) * 2)
    },
  }
}

describe('stress: repeated invocation stability', () => {
  it(
    'produces correct results across 5,000 all() invocations',
    { timeout: 60_000 },
    async () => {
      const start = Date.now()

      for (let i = 0; i < 5_000; i++) {
        const result = await all(buildSmallGraph())
        // Asserting the full shape on every iteration catches per-call state
        // leaks (e.g. a result map accidentally shared between calls).
        expect(result).toEqual(SMALL_GRAPH_EXPECTED)
      }

      const elapsed = Date.now() - start
      console.log(`[stress] 5,000 all() invocations took ${elapsed}ms`)
      expect(elapsed).toBeLessThan(10_000)
    },
  )

  it(
    'produces correct results across 1,000 allSettled() invocations',
    { timeout: 60_000 },
    async () => {
      const start = Date.now()

      for (let i = 0; i < 1_000; i++) {
        const result = await allSettled(buildSmallGraph())
        expect(result.a).toEqual({ status: 'fulfilled', value: 1 })
        expect(result.b).toEqual({ status: 'fulfilled', value: 2 })
        expect(result.e).toEqual({ status: 'fulfilled', value: 31 })
        expect(result.f).toEqual({ status: 'fulfilled', value: 32 })
        expect(result.g).toEqual({ status: 'fulfilled', value: [1, 2, 32] })
      }

      const elapsed = Date.now() - start
      console.log(`[stress] 1,000 allSettled() invocations took ${elapsed}ms`)
      expect(elapsed).toBeLessThan(10_000)
    },
  )

  it(
    'produces correct results across 1,000 flow() invocations',
    { timeout: 60_000 },
    async () => {
      const start = Date.now()

      for (let i = 0; i < 1_000; i++) {
        const result = await flow<number>(buildFlowGraph())
        expect(result).toBe(6)
      }

      const elapsed = Date.now() - start
      console.log(`[stress] 1,000 flow() invocations took ${elapsed}ms`)
      expect(elapsed).toBeLessThan(10_000)
    },
  )
})

describe('stress: heap guard', () => {
  it(
    'keeps heap growth bounded across repeated calls',
    { timeout: 60_000 },
    async () => {
      const start = Date.now()
      // `gc` is only defined when node is started with `--expose-gc`.
      const gcFn = typeof gc === 'function' ? gc : undefined

      const runBatch = async (n: number) => {
        for (let i = 0; i < n; i++) {
          const result = await all(buildSmallGraph())
          if (result.f !== 32) {
            throw new Error(
              `unexpected result at iteration ${i}: ${JSON.stringify(result)}`,
            )
          }
        }
      }

      // Warm up so lazily allocated internals are not counted as growth.
      await runBatch(500)

      if (gcFn) gcFn()
      const before = process.memoryUsage().heapUsed

      await runBatch(5_000)

      if (gcFn) gcFn()
      const after = process.memoryUsage().heapUsed
      const growth = after - before
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)}MB`

      console.log(
        `[stress] heapUsed before=${mb(before)} after=${mb(after)} growth=${mb(
          growth,
        )} gc=${gcFn ? 'enabled' : 'unavailable'}`,
      )

      // Only assert bounded growth when we can actually force a collection,
      // otherwise just make sure the workload completed within budget.
      if (gcFn) {
        expect(growth).toBeLessThan(20 * 1024 * 1024)
      }

      expect(Date.now() - start).toBeLessThan(30_000)
    },
  )
})

describe('stress: external AbortSignal listener hygiene', () => {
  it('removes the external abort listener after a successful run', async () => {
    const controller = new AbortController()

    const result = await all(
      {
        async a() {
          await sleep(1)
          return 1
        },
        async b() {
          return (await this.$.a) + 1
        },
      },
      { signal: controller.signal },
    )

    expect(result).toEqual({ a: 1, b: 2 })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('removes the external abort listener after an aborted run', async () => {
    const controller = new AbortController()

    const promise = all(
      {
        async a() {
          await new Promise((_, reject) => {
            this.$signal.addEventListener('abort', () =>
              reject(this.$signal.reason),
            )
          })
        },
        async b() {
          await new Promise((_, reject) => {
            this.$signal.addEventListener('abort', () =>
              reject(this.$signal.reason),
            )
          })
        },
      },
      { signal: controller.signal },
    )

    // Let the tasks start and register their abort listeners.
    await sleep(0)
    controller.abort(new Error('x'))

    await expect(promise).rejects.toThrow('x')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

describe('stress: graph shapes', () => {
  it(
    'resolves a wide graph of 2,000 independent tasks in under 1s',
    { timeout: 60_000 },
    async () => {
      const tasks: Record<string, () => number> = {}
      const expected: Record<string, number> = {}
      for (let i = 0; i < 2_000; i++) {
        tasks[`task${i}`] = () => i
        expected[`task${i}`] = i
      }

      const start = Date.now()
      const result = await all(tasks as any)
      const elapsed = Date.now() - start

      expect(result).toEqual(expected)
      console.log(`[stress] wide graph (2,000 tasks) took ${elapsed}ms`)
      expect(elapsed).toBeLessThan(1_000)
    },
  )

  it(
    'resolves a deep 1,000-task dependency chain without stack overflow',
    { timeout: 60_000 },
    async () => {
      const tasks: Record<string, () => unknown> = { task0: () => 0 }
      for (let i = 1; i < 1_000; i++) {
        const prev = `task${i - 1}`
        tasks[`task${i}`] = async function (this: any) {
          return (await this.$[prev]) + 1
        }
      }

      const result = await all(tasks as any)

      expect(result.task0).toBe(0)
      expect(result.task999).toBe(999)
      expect(Object.keys(result)).toHaveLength(1_000)
    },
  )

  it('runs independent tasks in parallel (three 50ms tasks under 100ms)', async () => {
    const start = Date.now()

    const result = await all({
      async a() {
        await sleep(50)
        return 1
      },
      async b() {
        await sleep(50)
        return 2
      },
      async c() {
        await sleep(50)
        return 3
      },
    })

    const elapsed = Date.now() - start

    expect(result).toEqual({ a: 1, b: 2, c: 3 })
    // Sequential execution would take ~150ms; parallel is ~50ms. 100ms leaves
    // headroom while still catching accidental serialization.
    expect(elapsed).toBeLessThan(100)
  })
})
