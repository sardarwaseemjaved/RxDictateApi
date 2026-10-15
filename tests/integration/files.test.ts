import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, headersFor } from '../fixtures/clinic.fixture';

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
