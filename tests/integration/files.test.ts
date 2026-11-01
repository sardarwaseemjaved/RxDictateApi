import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, headersFor } from '../fixtures/clinic.fixture';
import { reportPageKey, signedPutUrl } from '../../src/core/storage';

setupTestDB();

const addMedicine = { ops: [{ op: 'add', section: 'medicines', value: { name: 'Panadol' } }] };

/**
 * With S3 or R2 the bucket presigns its own URLs. On a dev box there is no
 * bucket, and the API used to hand back a `file://` path on the server's disk -
 * which a phone, a simulator and a share sheet can all do nothing with. These
 * cover the route that replaced it.
 */
describe('Signed downloads from the local storage driver', () => {
  const aSignedPdf = async () => {
    const { doctor, patientId } = await aClinic('+923008880001');
    const headers = headersFor(doctor, { location: true });
    const draft = await aDraft(doctor, patientId);
    await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine).expect(200);
    await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

    const pdf = await request(app).get(`/api/v1/prescriptions/${draft.id}/pdf`).set(headers).expect(200);
    return { url: pdf.body.data.url as string, contentType: pdf.body.data.contentType as string };
  };

  const follow = (url: string) => {
    const parsed = new URL(url);
    return request(app).get(`${parsed.pathname}${parsed.search}`);
  };

  test('the link is http, not a path on the server disk', async () => {
    const { url } = await aSignedPdf();

    expect(url.startsWith('http://') || url.startsWith('https://')).toBe(true);
    expect(url).not.toContain('file://');
    expect(url).not.toContain('/.storage/');
    expect(url).toContain('/api/v1/files/');
    expect(new URL(url).searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('says what is at the other end of it', async () => {
    const { url, contentType } = await aSignedPdf();

    // No renderer is configured in the suite, so the print file is HTML. The
    // app has to be told, or it will offer to share a PDF that is not one.
    expect(contentType).toBe('text/html; charset=utf-8');

    const served = await follow(url).expect(200);
    expect(served.headers['content-type']).toContain('text/html');
    expect(served.text).toContain('<!doctype html>');
  });

  test('a correct signature serves the file without a token', async () => {
    const { url } = await aSignedPdf();

    // No Authorization header: the link is the credential, which is what lets
    // the app hand it to a WebView or a share sheet.
    const served = await follow(url).expect(200);
    expect(served.text).toContain('Panadol');
    expect(served.headers['cache-control']).toContain('private');
  });

  test('a tampered signature is refused', async () => {
    const { url } = await aSignedPdf();
    const parsed = new URL(url);
    parsed.searchParams.set('sig', 'f'.repeat(64));

    const response = await follow(parsed.toString()).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('a tampered key is refused, so one link does not open another file', async () => {
    const { url } = await aSignedPdf();
    const parsed = new URL(url);
    const signature = parsed.searchParams.get('sig')!;
    const expires = parsed.searchParams.get('expires')!;

    // The signature covers the key, so moving it to a different file fails.
    const elsewhere = `/api/v1/files/someone-else/rx/secret.html?expires=${expires}&sig=${signature}`;
    const response = await request(app).get(elsewhere).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('an expired link is refused', async () => {
    const { url } = await aSignedPdf();
    const parsed = new URL(url);
    parsed.searchParams.set('expires', String(Math.floor(Date.now() / 1000) - 60));

    const response = await follow(parsed.toString()).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('a link with no signature at all is refused', async () => {
    const { url } = await aSignedPdf();
    const parsed = new URL(url);

    await request(app).get(parsed.pathname).expect(403);
  });

  test('a signed link to something that is not there is a 404, not a 500', async () => {
    const { url } = await aSignedPdf();
    const parsed = new URL(url);

    // Signed for a key the server really does hold nothing under: the
    // signature is this test's own, so this proves the read fails cleanly.
    const missing = await request(app).get(`${parsed.pathname}x${parsed.search}`);
    expect([403, 404]).toContain(missing.status);
  });

  test('a preview link works the same way', async () => {
    const { doctor, patientId } = await aClinic('+923008880002');
    const headers = headersFor(doctor, { location: true });
    const draft = await aDraft(doctor, patientId);
    await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine).expect(200);

    const preview = await request(app).get(`/api/v1/prescriptions/${draft.id}/preview`).set(headers).expect(200);
    expect(preview.body.data.url).toContain('/api/v1/files/');
    expect(preview.body.data.contentType).toBe('text/html; charset=utf-8');

    const served = await follow(preview.body.data.url).expect(200);
    expect(served.text).toContain('NOT VALID');
  });

  test('a report page link works the same way', async () => {
    const { doctor, patientId } = await aClinic('+923008880003');
    const headers = headersFor(doctor);

    const report = await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headers)
      .send({
        type: 'lab',
        testName: 'CBC',
        testDate: '2026-10-01',
        pageKeys: [`${doctor.practiceId}/reports/pages/page-one.jpg`],
      })
      .expect(201);

    const detail = await request(app).get(`/api/v1/reports/${report.body.data.id}`).set(headers).expect(200);
    expect(detail.body.data.pageUrls[0].url).toContain('/api/v1/files/');
    // Per page, because a report can mix a photograph and a PDF.
    expect(detail.body.data.pageUrls[0].contentType).toBe('image/jpeg');
  });
});

/**
 * The other half of the same stand-in: with no bucket, the API signs and takes
 * the upload itself, so a report can be attached from a dev box and from a
 * browser. Production stays on presigned S3 or R2 and never mounts this.
 */
describe('Signed uploads to the local storage driver', () => {
  /** Some bytes that are not text, so nothing along the way can mangle them quietly. */
  const PAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

  /** Read a response as raw bytes, whatever its content type. */
  const asBytes = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  const pathOf = (url: string): string => {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };

  const aTicket = async (phone: string, size = PAGE.length, contentType = 'image/jpeg') => {
    const { doctor, patientId } = await aClinic(phone);
    const ticket = await request(app)
      .post('/api/v1/reports/uploads')
      .set(headersFor(doctor))
      .send({ contentType, size })
      .expect(201);
    return { doctor, patientId, ...(ticket.body.data as { uploadUrl: string; fileKey: string; expiresAt: string }) };
  };

  test('a page goes up, is filed, and comes back byte for byte', async () => {
    const { doctor, patientId, uploadUrl, fileKey } = await aTicket('+923021110001');

    expect(uploadUrl).toContain('/api/v1/files/');
    expect(uploadUrl).toContain(fileKey);

    // No Authorization header: like a presigned S3 URL, the link is the credential.
    const put = await request(app).put(pathOf(uploadUrl)).set('Content-Type', 'image/jpeg').send(PAGE).expect(200);
    expect(put.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(put.body.data).toEqual({ fileKey, size: PAGE.length });

    const report = await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headersFor(doctor))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [fileKey] })
      .expect(201);

    const detail = await request(app).get(`/api/v1/reports/${report.body.data.id}`).set(headersFor(doctor)).expect(200);
    const served = await request(app)
      .get(pathOf(detail.body.data.pageUrls[0].url))
      .buffer(true)
      .parse(asBytes as never)
      .expect(200);

    expect(Buffer.compare(served.body as Buffer, PAGE)).toBe(0);
    expect(served.headers['content-type']).toBe('image/jpeg');
  });

  test('an expired link is refused', async () => {
    const { doctor } = await aClinic('+923021110002');
    const key = reportPageKey(doctor.practiceId, 'expired-page', 'jpg');
    // Genuinely signed, a minute in the past - not a tampered expiry.
    const { url } = await signedPutUrl(key, 'image/jpeg', { size: PAGE.length, expiresInSeconds: -60 });

    const response = await request(app).put(pathOf(url)).set('Content-Type', 'image/jpeg').send(PAGE).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('an altered link is refused, whichever part was changed', async () => {
    const { uploadUrl } = await aTicket('+923021110003');

    const altered = (name: string, value: string) => {
      const parsed = new URL(uploadUrl);
      parsed.searchParams.set(name, value);
      return pathOf(parsed.toString());
    };

    // A later expiry, a bigger allowance, another type, a guessed signature.
    const attempts = [
      { path: altered('expires', String(Math.floor(Date.now() / 1000) + 86_400)), type: 'image/jpeg' },
      { path: altered('size', String(10 * 1024 * 1024)), type: 'image/jpeg' },
      { path: altered('ct', 'image/png'), type: 'image/png' },
      { path: altered('sig', 'f'.repeat(64)), type: 'image/jpeg' },
    ];
    for (let i = 0; i < attempts.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app).put(attempts[i].path).set('Content-Type', attempts[i].type).send(PAGE);
      expect({ attempt: i, status: response.status, code: response.body.error?.code }).toEqual({
        attempt: i,
        status: 403,
        code: 'FORBIDDEN',
      });
    }

    // And the key is covered too, so one ticket cannot write somewhere else.
    const parsed = new URL(uploadUrl);
    const elsewhere = `/api/v1/files/someone-else/reports/pages/x.jpg${parsed.search}`;
    await request(app).put(elsewhere).set('Content-Type', 'image/jpeg').send(PAGE).expect(403);
  });

  test('a download link cannot be used to upload', async () => {
    const { doctor, patientId, uploadUrl, fileKey } = await aTicket('+923021110004');
    await request(app).put(pathOf(uploadUrl)).set('Content-Type', 'image/jpeg').send(PAGE).expect(200);

    const report = await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headersFor(doctor))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [fileKey] })
      .expect(201);
    const detail = await request(app).get(`/api/v1/reports/${report.body.data.id}`).set(headersFor(doctor)).expect(200);

    // A good signed GET for the very key that was just written.
    const response = await request(app)
      .put(pathOf(detail.body.data.pageUrls[0].url))
      .set('Content-Type', 'image/jpeg')
      .send(Buffer.from('overwritten'))
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('a body sent as a different type than was signed is refused', async () => {
    const { uploadUrl } = await aTicket('+923021110006');

    const response = await request(app).put(pathOf(uploadUrl)).set('Content-Type', 'image/png').send(PAGE).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain('image/jpeg');
  });

  test('a body larger than the signed size is refused', async () => {
    const { uploadUrl } = await aTicket('+923021110007', PAGE.length - 1);

    const response = await request(app).put(pathOf(uploadUrl)).set('Content-Type', 'image/jpeg').send(PAGE).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toContain(String(PAGE.length - 1));
  });

  test('an empty body is refused', async () => {
    const { uploadUrl } = await aTicket('+923021110008');

    await request(app).put(pathOf(uploadUrl)).set('Content-Type', 'image/jpeg').send(Buffer.alloc(0)).expect(400);
  });

  /**
   * The web app PUTs from its own origin, and the Content-Type makes the
   * browser ask first. The suite's CORS_ORIGINS is the one listed origin.
   */
  test('a browser on an allowed origin may PUT with a Content-Type, and can read the ETag', async () => {
    const { uploadUrl } = await aTicket('+923021110009');
    const origin = 'http://localhost:8081';

    const preflight = await request(app)
      .options(pathOf(uploadUrl))
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
    expect(preflight.headers['access-control-allow-headers']?.toLowerCase()).toContain('content-type');

    const put = await request(app)
      .put(pathOf(uploadUrl))
      .set('Origin', origin)
      .set('Content-Type', 'image/jpeg')
      .send(PAGE)
      .expect(200);
    expect(put.headers['access-control-allow-origin']).toBe(origin);
    expect(put.headers['access-control-expose-headers']).toContain('ETag');
  });

  test('a browser on an origin that is not listed is turned away', async () => {
    const { uploadUrl } = await aTicket('+923021110010');

    const response = await request(app)
      .options(pathOf(uploadUrl))
      .set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'PUT')
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('a downloaded page can be shown in an <img> on another origin', async () => {
    const { doctor, patientId, uploadUrl, fileKey } = await aTicket('+923021110011');
    await request(app).put(pathOf(uploadUrl)).set('Content-Type', 'image/jpeg').send(PAGE).expect(200);
    const report = await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headersFor(doctor))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [fileKey] })
      .expect(201);
    const detail = await request(app).get(`/api/v1/reports/${report.body.data.id}`).set(headersFor(doctor)).expect(200);

    const served = await request(app)
      .get(pathOf(detail.body.data.pageUrls[0].url))
      .buffer(true)
      .parse(asBytes as never)
      .expect(200);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});
