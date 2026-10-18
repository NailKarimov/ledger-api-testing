import { test, expect } from '@playwright/test';
import { redact, redactHeaders, redactTokens } from '../../src/api/redact';

/** The Allure report is public, so the key must never appear in attachments or errors. */
test.describe('API key redaction', () => {
  test('appid query parameter is masked', () => {
    expect(redact('https://api.example/weather?lat=1&appid=abc123&lon=2')).toBe(
      'https://api.example/weather?lat=1&appid=***&lon=2',
    );
  });

  test('the raw key is masked anywhere in a message', () => {
    expect(redact('connect ECONNRESET for key abc123', 'abc123')).toBe('connect ECONNRESET for key ***');
  });

  test('a JWT keeps its readable header and claims but loses the signature', () => {
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl';
    expect(redactTokens(`{"access_token":"${jwt}"}`)).toBe(
      '{"access_token":"eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.***"}',
    );
  });

  test('codes, verifiers, refresh tokens and secrets are masked in forms and JSON', () => {
    expect(
      redactTokens(
        'grant_type=authorization_code&code=abc-1&code_verifier=v.~x&client_secret=s3&code_challenge=C',
      ),
    ).toBe('grant_type=authorization_code&code=***&code_verifier=***&client_secret=***&code_challenge=C');
    expect(redactTokens('{"refresh_token":"r-123","token_type":"Bearer"}')).toBe(
      '{"refresh_token":"***","token_type":"Bearer"}',
    );
  });

  test('the Authorization header keeps only its scheme', () => {
    expect(redactHeaders({ Authorization: 'Bearer eyJabc', 'Idempotency-Key': 'k' })).toEqual({
      Authorization: 'Bearer ***',
      'Idempotency-Key': 'k',
    });
  });
});
