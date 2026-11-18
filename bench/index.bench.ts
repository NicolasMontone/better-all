import { bench, describe } from 'vitest'
import { all, allSettled, flow } from '../lib/index'

// Every task below resolves in the same tick: sync returns, already-resolved
// promises, or awaiting dependencies whose producers have already settled.
// No setTimeout / Date.now / performance.now is involved, so the measured
// cost is the scheduling/dependency overhead of the library itself.

/** Build `count` independent tasks, each returning its index synchronously. */
function makeIndependentTasks(count: number): Record<string, () => number> {
  const tasks: Record<string, () => number> = {}
  for (let i = 0; i < count; i++) {
    tasks[`task${i}`] = () => i
  }
  return tasks
}

/**
 * Build a linear chain of `length` tasks. Each task (except the head) awaits
 * the result of the previous task: `const p = await this.$[prev]; return p + 1`.
 */
function makeChainTasks(
  length: number,
): Record<string, (...args: any[]) => any> {
  const tasks: Record<string, (...args: any[]) => any> = {
    task0: () => 0,
  }
  for (let i = 1; i < length; i++) {
    const prev = `task${i - 1}`
    tasks[`task${i}`] = async function (this: any) {
      const p = await this.$[prev]
      return p + 1
    }
  }
  return tasks
}

// Allocated once and reused so the benchmark loop measures the library call,
// not task-object construction.
const independent10 = makeIndependentTasks(10)
const independent100 = makeIndependentTasks(100)
const chain50 = makeChainTasks(50)

// A rejection for the allSettled scenario, created once (no per-iteration
// allocation of the error object).
const rejection = new Error('benchmark rejection')

/** Nine fulfilled tasks plus one that throws (allSettled never rejects). */
function makeSettledTasks(count: number): Record<string, () => number> {
  const tasks: Record<string, () => number> = {}
  for (let i = 0; i < count - 1; i++) {
    tasks[`task${i}`] = () => i
  }
  tasks[`task${count - 1}`] = () => {
    throw rejection
  }
  return tasks
}

const settled10 = makeSettledTasks(10)

describe('hot paths', () => {
  bench('all: 10 independent tasks', async () => {
    await all(independent10)
  })

  bench('all: 100 independent tasks', async () => {
    await all(independent100)
  })

  bench('all: diamond dependency graph', async () => {
    await all({
      a: () => 1,
      async b() {
        return (await this.$.a) + 1
      },
      async c() {
        return (await this.$.a) + 2
      },
      async d() {
        return (await this.$.b) + (await this.$.c)
      },
    })
  })

  bench('all: 50-task dependency chain', async () => {
    await all(chain50)
  })

  bench('all: same dependency awaited 5 times', async () => {
    await all({
      a: () => 1,
      async b() {
        const r1 = await this.$.a
        const r2 = await this.$.a
        const r3 = await this.$.a
        const r4 = await this.$.a
        const r5 = await this.$.a
        return r1 + r2 + r3 + r4 + r5
      },
    })
  })

  bench('allSettled: 10 tasks, one rejects', async () => {
    await allSettled(settled10)
  })

  bench('flow: early exit via $end', async () => {
    await flow<number>({
      a() {
        this.$end(1)
      },
      async b() {
        const first = await Promise.resolve(1)
        const second = await Promise.resolve(2)
        return first + second
      },
    })
  })

  bench('flow: normal completion without $end', async () => {
    await flow<number>({
      a: () => 1,
      b: async () => 2,
    })
  })
})
