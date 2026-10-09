import { describe, it, expect } from 'vitest';
import {
  twilioSignature,
  verifyTwilioSignature,
  normalizeE164,
  parseTwilioInbound,
  parseTwilioStatus,
  splitMessage,
  TwilioWhatsAppClient,
  TwilioApiError,
  TWILIO_MAX_BODY,
} from '../src/twilio';

// The fixture twilio-node's own test suite signs (auth token "12345").
const token = '12345';
const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
const fixtureSignature = 'RSOYDt4T1cUTdK1PDd93/VVr8B8=';

describe('twilioSignature / verifyTwilioSignature', () => {
  it("matches Twilio's reference signature", () => {
    expect(twilioSignature(token, url, params)).toBe(fixtureSignature);
    expect(verifyTwilioSignature(token, fixtureSignature, url, params)).toBe(true);
  });
  it('rejects a tampered param, a wrong token, a wrong URL, or no header', () => {
    expect(verifyTwilioSignature(token, fixtureSignature, url, { ...params, Digits: '9999' })).toBe(false);
    expect(verifyTwilioSignature('54321', fixtureSignature, url, params)).toBe(false);
    expect(verifyTwilioSignature(token, fixtureSignature, 'https://evil.example/myapp.php?foo=1&bar=2', params)).toBe(false);
    expect(verifyTwilioSignature(token, undefined, url, params)).toBe(false);
    expect(verifyTwilioSignature(token, 'garbage', url, params)).toBe(false);
  });
  it('accepts when any candidate URL matches, including the port-less form', () => {
    expect(verifyTwilioSignature(token, fixtureSignature, ['https://proxy.internal/x', 'https://mycompany.com:443/myapp.php?foo=1&bar=2'], params)).toBe(true);
    const sig = twilioSignature(token, 'http://203.0.113.7:8090/hook', params);
    expect(verifyTwilioSignature(token, sig, 'http://203.0.113.7:8090/hook', params)).toBe(true);
  });
  it('signs every value of a repeated param, sorted', () => {
    const a = twilioSignature(token, url, { K: ['b', 'a'] });
    expect(a).toBe(twilioSignature(token, url, { K: ['a', 'b'] }));
    expect(a).not.toBe(twilioSignature(token, url, { K: 'a' }));
  });
});

describe('normalizeE164', () => {
  it('cleans what people type and what Twilio sends', () => {
    expect(normalizeE164('whatsapp:+14155238886')).toBe('+14155238886');
    expect(normalizeE164('+1 (415) 523-8886')).toBe('+14155238886');
    expect(normalizeE164('00972501234567')).toBe('+972501234567');
    expect(normalizeE164('972501234567')).toBe('+972501234567');
  });
  it('rejects things that are not phone numbers', () => {
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('+0123456789')).toBeNull();
    expect(normalizeE164('12345')).toBeNull();
    expect(normalizeE164('call me')).toBeNull();
  });
});

const inbound = (extra: Record<string, string> = {}) => ({
  MessageSid: 'SM123',
  SmsMessageSid: 'SM123',
  AccountSid: 'AC123',
  From: 'whatsapp:+972501234567',
  To: 'whatsapp:+14155238886',
  Body: 'hello',
  NumMedia: '0',
  ProfileName: 'Dana',
  WaId: '972501234567',
  ...extra,
});

describe('parseTwilioInbound', () => {
  it('extracts a WhatsApp text message', () => {
    expect(parseTwilioInbound(inbound())).toEqual({
      messageSid: 'SM123', accountSid: 'AC123', from: '+972501234567', to: '+14155238886', body: 'hello', profileName: 'Dana', media: [],
    });
  });
  it('collects media and strips content-type parameters', () => {
    const m = parseTwilioInbound(inbound({ Body: '', NumMedia: '2', MediaUrl0: 'https://api.twilio.com/m/0', MediaContentType0: 'image/jpeg', MediaUrl1: 'https://api.twilio.com/m/1', MediaContentType1: 'application/pdf; charset=binary' }));
    expect(m?.media).toEqual([{ url: 'https://api.twilio.com/m/0', contentType: 'image/jpeg' }, { url: 'https://api.twilio.com/m/1', contentType: 'application/pdf' }]);
  });
  it('turns a tapped button or a shared location into text', () => {
    expect(parseTwilioInbound(inbound({ Body: '', ButtonText: 'Yes please' }))?.body).toBe('Yes please');
    expect(parseTwilioInbound(inbound({ Body: '', Latitude: '32.08', Longitude: '34.78', Label: 'Office' }))?.body).toBe('[location: 32.08, 34.78 — Office]');
  });
  it('ignores SMS and malformed posts', () => {
    expect(parseTwilioInbound(inbound({ From: '+972501234567', To: '+14155238886' }))).toBeNull();
    expect(parseTwilioInbound(inbound({ MessageSid: '', SmsMessageSid: '' }))).toBeNull();
    expect(parseTwilioInbound({})).toBeNull();
  });
});

describe('parseTwilioStatus', () => {
  it('reads a failed delivery', () => {
    expect(parseTwilioStatus({ MessageSid: 'SM9', MessageStatus: 'undelivered', ErrorCode: '63016', From: 'whatsapp:+14155238886', To: 'whatsapp:+972501234567' }))
      .toEqual({ messageSid: 'SM9', status: 'undelivered', errorCode: '63016', from: '+14155238886', to: '+972501234567' });
  });
  it('reads a successful one, and rejects junk', () => {
    expect(parseTwilioStatus({ MessageSid: 'SM9', MessageStatus: 'delivered', To: 'whatsapp:+972501234567' })?.errorCode).toBeNull();
    expect(parseTwilioStatus({ MessageStatus: 'sent' })).toBeNull();
  });
});

describe('splitMessage', () => {
  it('keeps a short message whole', () => {
    expect(splitMessage('  hi there  ')).toEqual(['hi there']);
    expect(splitMessage('')).toEqual([]);
  });
  it('splits a long reply at paragraph boundaries, each part within the limit', () => {
    const para = 'x'.repeat(900);
    const parts = splitMessage([para, para, para].join('\n\n'));
    expect(parts).toEqual([para, para, para]);
  });
  it('prefers a sentence, then a word, and only hard-cuts unbroken text', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const parts = splitMessage(sentences, 200);
    expect(parts.every((p) => p.length <= 200 && p.endsWith('.'))).toBe(true);
    expect(parts.join(' ')).toBe(sentences);
    const blob = 'y'.repeat(TWILIO_MAX_BODY * 2 + 5);
    expect(splitMessage(blob).map((p) => p.length)).toEqual([TWILIO_MAX_BODY, TWILIO_MAX_BODY, 5]);
  });
  it('never splits an emoji', () => {
    const s = 'a'.repeat(9) + '😀' + 'b';
    expect(splitMessage(s, 10)).toEqual(['a'.repeat(9), '😀b']);
  });
});

/** A fetch stub that records each call and answers with the queued responses in order. */
function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (u: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(u), init });
    const r = responses.shift() ?? { status: 200, body: {} };
    const body = typeof r.body === 'string' || r.body instanceof Uint8Array ? r.body : JSON.stringify(r.body);
    return new Response(body as ConstructorParameters<typeof Response>[0], { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { impl, calls };
}

describe('TwilioWhatsAppClient', () => {
  it('sends with Basic auth, whatsapp: addresses and the status callback', async () => {
    const f = fakeFetch([{ status: 201, body: { sid: 'SMabc' } }]);
    const c = new TwilioWhatsAppClient({ accountSid: 'AC1', authToken: 'tok', statusCallback: 'https://w.example/api/twilio/status/h1', fetchImpl: f.impl });
    expect(await c.sendText('+14155238886', '+972501234567', 'hi')).toEqual({ messageId: 'SMabc', messageIds: ['SMabc'] });
    expect(f.calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Basic ' + Buffer.from('AC1:tok').toString('base64'));
    const sent = new URLSearchParams(String(f.calls[0].init.body));
    expect(Object.fromEntries(sent)).toEqual({ From: 'whatsapp:+14155238886', To: 'whatsapp:+972501234567', Body: 'hi', StatusCallback: 'https://w.example/api/twilio/status/h1' });
  });
  it('sends an over-long reply as several messages, in order', async () => {
    const f = fakeFetch([{ status: 201, body: { sid: 'SM1' } }, { status: 201, body: { sid: 'SM2' } }]);
    const c = new TwilioWhatsAppClient({ accountSid: 'AC1', authToken: 'tok', fetchImpl: f.impl });
    const r = await c.sendText('+14155238886', '+972501234567', 'a'.repeat(1000) + '\n\n' + 'b'.repeat(1000));
    expect(r.messageIds).toEqual(['SM1', 'SM2']);
    expect(f.calls.map((x) => new URLSearchParams(String(x.init.body)).get('Body')?.[0])).toEqual(['a', 'b']);
  });
  it("surfaces Twilio's error code", async () => {
    const f = fakeFetch([{ status: 401, body: { code: 20003, message: 'Authenticate', status: 401 } }]);
    const c = new TwilioWhatsAppClient({ accountSid: 'AC1', authToken: 'bad', fetchImpl: f.impl });
    const err = await c.fetchAccount().catch((e) => e);
    expect(err).toBeInstanceOf(TwilioApiError);
    expect(err).toMatchObject({ status: 401, code: 20003 });
  });
  it('reads the account behind the credentials', async () => {
    const f = fakeFetch([{ status: 200, body: { friendly_name: 'My first account', status: 'active', type: 'Trial' } }]);
    const c = new TwilioWhatsAppClient({ accountSid: 'AC1', authToken: 'tok', fetchImpl: f.impl });
    expect(await c.fetchAccount()).toEqual({ friendlyName: 'My first account', status: 'active', type: 'Trial' });
    expect(f.calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1.json');
  });
  it('downloads media with credentials only for Twilio hosts, and enforces the size cap', async () => {
    const f = fakeFetch([
      { status: 200, body: new Uint8Array([1, 2, 3]) },
      { status: 200, body: new Uint8Array([4]) },
      { status: 200, body: new Uint8Array(10) },
    ]);
    const c = new TwilioWhatsAppClient({ accountSid: 'AC1', authToken: 'tok', fetchImpl: f.impl });
    expect([...(await c.downloadMedia('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1'))!]).toEqual([1, 2, 3]);
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    await c.downloadMedia('https://elsewhere.example/file');
    expect((f.calls[1].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(await c.downloadMedia('https://api.twilio.com/big', 5)).toBeNull();
    expect(await c.downloadMedia('not a url')).toBeNull();
  });
});
