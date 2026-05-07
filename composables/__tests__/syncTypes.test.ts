/**
 * Tests for `classifySyncError` and `friendlySyncErrorMessage`  - the
 * sync error category helpers introduced as part of the sync UX cleanup.
 *
 * The point of this file is to pin the patterns the engine uses to detect
 * common failure modes (CORS, network, auth, server) so a future change to
 * the patterns has to update both the tests and the implementation
 * deliberately. The branch manager dropdown depends on this classification
 *  - if it drifts, users see the wrong message or the unhelpful "Sync
 * error" fallback.
 */

import { describe, it, expect } from 'vitest'
import { classifySyncError, friendlySyncErrorMessage } from '../syncTypes'
import type { SyncErrorCategory } from '../syncTypes'

describe('classifySyncError', () => {
  it('returns "unknown" for null and undefined', () => {
    expect(classifySyncError(null)).toBe('unknown')
    expect(classifySyncError(undefined)).toBe('unknown')
  })

  describe('status code based', () => {
    it('classifies 401 as auth', () => {
      expect(classifySyncError({ statusCode: 401 })).toBe('auth')
    })
    it('classifies 403 as auth', () => {
      expect(classifySyncError({ statusCode: 403 })).toBe('auth')
    })
    it('classifies 409 as conflict', () => {
      expect(classifySyncError({ statusCode: 409 })).toBe('conflict')
    })
    it('classifies 500 as server', () => {
      expect(classifySyncError({ statusCode: 500 })).toBe('server')
    })
    it('classifies 503 as server', () => {
      expect(classifySyncError({ statusCode: 503 })).toBe('server')
    })
    it('also reads `status` (not just `statusCode`)', () => {
      expect(classifySyncError({ status: 401 })).toBe('auth')
    })
  })

  describe('message-based fallbacks', () => {
    it('classifies messages containing "CORS" as cors', () => {
      expect(classifySyncError(new Error('Has been blocked by CORS policy'))).toBe('cors')
    })
    it('classifies "fetch + err_failed" as cors (the R2 preflight signature)', () => {
      // When the browser throws a CORS preflight failure into JS, ofetch
      // surfaces it as a TypeError with both "fetch" and "err_failed" in
      // the body. Plain "net::ERR_FAILED" without "fetch" lands as
      // network  - see the next test.
      expect(classifySyncError(new Error('TypeError: fetch failed err_failed'))).toBe('cors')
    })
    it('classifies bare ERR_FAILED as network (browser preflight + offline both look like this)', () => {
      // Chromium surfaces both genuine network failures and opaque CORS
      // preflight rejections as `net::ERR_FAILED`. JS cannot tell them
      // apart from the error alone, so we treat them as network and the
      // dropdown tooltip mentions CORS as a possible cause.
      expect(classifySyncError(new Error('PUT https://r2.example/x net::ERR_FAILED')))
        .toBe('network')
    })
    it('classifies "Failed to fetch" as network', () => {
      expect(classifySyncError(new Error('Failed to fetch'))).toBe('network')
    })
    it('classifies NetworkError as network', () => {
      expect(classifySyncError(new Error('NetworkError when attempting to fetch'))).toBe('network')
    })
    it('classifies ECONNREFUSED as network', () => {
      expect(classifySyncError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toBe('network')
    })
    it('classifies "No encryption key" as crypto', () => {
      expect(classifySyncError(new Error('No encryption key'))).toBe('crypto')
    })
    it('falls back to unknown for unclassified errors', () => {
      expect(classifySyncError(new Error('something weird'))).toBe('unknown')
    })
  })

  it('handles errors that are plain strings', () => {
    expect(classifySyncError('Failed to fetch')).toBe('network')
  })

  it('prefers status code over message  - a 500 with "fetch" in the body is server, not network', () => {
    const err = Object.assign(new Error('fetch failed'), { statusCode: 500 })
    expect(classifySyncError(err)).toBe('server')
  })
})

describe('friendlySyncErrorMessage', () => {
  it('returns a non-empty string for every category', () => {
    const categories: SyncErrorCategory[] = [
      'network', 'cors', 'auth', 'conflict', 'server', 'crypto', 'unknown',
    ]
    for (const c of categories) {
      const msg = friendlySyncErrorMessage(c)
      expect(typeof msg).toBe('string')
      expect(msg.length).toBeGreaterThan(0)
    }
  })

  it('messages are short enough for a narrow dropdown', () => {
    const categories: SyncErrorCategory[] = [
      'network', 'cors', 'auth', 'conflict', 'server', 'crypto', 'unknown',
    ]
    for (const c of categories) {
      // ~50 char budget  - the branch dropdown is 18rem wide.
      expect(friendlySyncErrorMessage(c).length).toBeLessThanOrEqual(50)
    }
  })

  it('does not contain stack trace fragments or URLs', () => {
    const categories: SyncErrorCategory[] = [
      'network', 'cors', 'auth', 'conflict', 'server', 'crypto', 'unknown',
    ]
    for (const c of categories) {
      const msg = friendlySyncErrorMessage(c)
      expect(msg).not.toMatch(/https?:\/\//)
      expect(msg).not.toMatch(/at .+\.ts/)
    }
  })
})
