import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildExternalAuthRedirectUrl,
  resolveExternalAuthUrls,
  selectExternalAuthUrl,
  validateExternalAuthUrl,
} from '../shared/utils/external-auth.ts'
import { isAuthConfigUnavailable } from '../app/composables/useAuthConfig.ts'

describe('external authentication redirects', () => {
  it('preserves local authentication when no URLs are configured', () => {
    assert.deepEqual(resolveExternalAuthUrls(undefined, ''), { login: null, signup: null })
  })

  it('selects distinct login and signup endpoints', () => {
    const urls = resolveExternalAuthUrls('https://accounts.example.com/login', 'https://accounts.example.com/signup')
    assert.equal(selectExternalAuthUrl(urls, 'login'), 'https://accounts.example.com/login')
    assert.equal(selectExternalAuthUrl(urls, 'signup'), 'https://accounts.example.com/signup')
  })

  it('uses the configured endpoint as the fallback for the missing intent', () => {
    assert.deepEqual(resolveExternalAuthUrls('https://accounts.example.com/login', undefined), {
      login: 'https://accounts.example.com/login',
      signup: 'https://accounts.example.com/login',
    })
    assert.deepEqual(resolveExternalAuthUrls(undefined, 'https://accounts.example.com/signup'), {
      login: 'https://accounts.example.com/signup',
      signup: 'https://accounts.example.com/signup',
    })
  })

  it('preserves the FeedLog page and safe query parameters', () => {
    const result = buildExternalAuthRedirectUrl(
      'https://accounts.example.com/login?source=feedlog',
      'https://feedback.example.com',
      '/p/idea?board=roadmap&sort=top#comments',
    )
    const redirect = new URL(result!)
    assert.equal(redirect.searchParams.get('source'), 'feedlog')
    assert.equal(
      redirect.searchParams.get('return_to'),
      'https://feedback.example.com/p/idea?board=roadmap&sort=top',
    )
  })

  it('rejects unsafe endpoints and strips credential-shaped return parameters', () => {
    assert.equal(validateExternalAuthUrl('javascript:alert(1)'), null)
    assert.equal(validateExternalAuthUrl('http://accounts.example.com/login'), null)
    assert.equal(validateExternalAuthUrl('https://user:pass@accounts.example.com/login'), null)
    assert.equal(validateExternalAuthUrl('https://accounts.example.com/login?api_key=secret'), null)
    assert.equal(validateExternalAuthUrl('https://feedback.example.com/api/sso/jwt'), null)
    assert.equal(validateExternalAuthUrl('http://localhost:4000/login'), 'http://localhost:4000/login')

    const result = buildExternalAuthRedirectUrl(
      'https://accounts.example.com/login',
      'https://feedback.example.com',
      '/invite?id=123&jwt=secret&access_token=secret',
    )
    assert.equal(
      new URL(result!).searchParams.get('return_to'),
      'https://feedback.example.com/invite?id=123',
    )
  })

  it('keeps explicitly local-credential flows local', () => {
    const urls = resolveExternalAuthUrls('https://accounts.example.com/login', null)
    assert.equal(selectExternalAuthUrl(urls, 'login', true), null)
  })

  it('is safe without a browser location and refuses a direct loop', () => {
    assert.equal(buildExternalAuthRedirectUrl('https://accounts.example.com/login', undefined, '/'), null)
    assert.equal(
      buildExternalAuthRedirectUrl(
        'https://feedback.example.com/login',
        'https://feedback.example.com',
        '/login?next=%2F',
      ),
      null,
    )
  })

  it('rejects invalid and cross-origin return destinations', () => {
    assert.equal(
      buildExternalAuthRedirectUrl(
        'https://accounts.example.com/login',
        'https://feedback.example.com/login?next=%2F',
        'https://evil.example/phishing',
      ),
      null,
    )
    assert.equal(
      buildExternalAuthRedirectUrl(
        'https://accounts.example.com/login',
        'https://feedback.example.com',
        '//evil.example/phishing',
      ),
      null,
    )
    assert.equal(
      buildExternalAuthRedirectUrl(
        'https://accounts.example.com/login',
        'not a valid origin',
        '/roadmap?sort=top',
      ),
      null,
    )
  })

  it('distinguishes unavailable configuration from an unconfigured success', () => {
    const unconfigured = {
      google: false,
      github: false,
      email: true,
      emailVerification: false,
      externalLoginUrl: null,
      externalSignupUrl: null,
    }
    assert.equal(isAuthConfigUnavailable(unconfigured), false)
    assert.equal(isAuthConfigUnavailable(undefined), true)
    assert.equal(isAuthConfigUnavailable(undefined, true), false)
  })
})
