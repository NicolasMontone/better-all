import { describe, it, expect } from 'vitest'
import * as api from '../src/index'

describe('public API surface', () => {
  it('exposes the expected functions from the real entry point', () => {
    expect(typeof api.all).toBe('function')
    expect(typeof api.allSettled).toBe('function')
    expect(typeof api.flow).toBe('function')
  })

  it('supports automatic dependency resolution via `all`', async () => {
    const result = await api.all({
      a() {
        return 1
      },
      async b() {
        return (await this.$.a) + 1
      },
    })

    expect(result).toEqual({ a: 1, b: 2 })
  })
})
