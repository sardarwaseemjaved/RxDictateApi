import config from '../config/config';
import logger from '../config/logger';
import { prescriptionPdfKey, prescriptionPreviewKey, put } from '../core/storage';
import type { PrescriptionDoc } from '../models';
import type { LetterheadSnapshot, MedicineItem, PrescriptionSections, TextItem } from '../shared/prescription.schema';
import { LIST_SECTIONS } from '../shared/prescription.schema';
import { medicineInstruction } from '../shared/dose';
import { wireSections } from './prescriptionOps.service';

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SECTION_TITLES: Record<string, { en: string; ur: string }> = {
  complaints: { en: 'Complaints', ur: 'شکایات' },
  history: { en: 'History', ur: 'تاریخ' },
  examination: { en: 'Examination', ur: 'معائنہ' },
  diagnosis: { en: 'Diagnosis', ur: 'تشخیص' },
  medicines: { en: 'Rx', ur: 'نسخہ' },
  labs: { en: 'Tests', ur: 'ٹیسٹ' },
  dietEat: { en: 'Eat', ur: 'کھائیں' },
  dietAvoid: { en: 'Avoid', ur: 'پرہیز' },
  advice: { en: 'Advice', ur: 'ہدایات' },
};

/** 1-0-1, or SOS. What the patient reads off the page. */
const patternText = (medicine: MedicineItem): string => {
  const { pattern } = medicine;
  if ('sos' in pattern) {
    return 'SOS';
  }
  return `${pattern.m}-${pattern.a}-${pattern.n}`;
};

const letterheadHtml = (snapshot: LetterheadSnapshot, bilingual: boolean): string => {
  const timings = snapshot.timings
    .filter((timing) => !timing.closed)
    .map((timing) => `${timing.day.toUpperCase()} ${timing.from}-${timing.to}`)
    .join(' &middot; ');

  return `<header class="letterhead">
      <div class="doctor">
        <h1>${escape(snapshot.doctorName)}</h1>
        <p class="quals">${escape(snapshot.qualifications.join(', '))}</p>
        ${snapshot.speciality ? `<p class="speciality">${escape(snapshot.speciality)}</p>` : ''}
        ${snapshot.pmdcNo ? `<p class="pmdc">PMDC ${escape(snapshot.pmdcNo)}</p>` : ''}
      </div>
      <div class="clinic">
        <h2>${escape(snapshot.locationName)}</h2>
        <p>${escape(snapshot.address)}</p>
        ${snapshot.phone ? `<p>${escape(snapshot.phone)}</p>` : ''}
        ${timings ? `<p class="timings">${timings}</p>` : ''}
      </div>
      ${
        bilingual && snapshot.letterhead.ur
          ? `<div class="clinic-ur" dir="rtl" lang="ur">${escape(snapshot.letterhead.ur)}</div>`
          : ''
      }
    </header>`;
};

/**
 * The dose in figures, then the same dose in words.
 *
 * The figures are what a doctor reads back; the words are what the patient
 * follows at home, which is why the Urdu line is the one that matters most on
 * this page. Both come from medicineInstruction, so what the app showed while
 * the doctor was typing is exactly what prints - and the timing is left off
 * the figures, because the words already say it.
 */
const medicinesHtml = (medicines: MedicineItem[], bilingual: boolean): string =>
  `<ol class="medicines">${medicines
    .map((medicine) => {
      const line = [medicine.name, medicine.strength].filter(Boolean).join(' ');
      const dose = [patternText(medicine), medicine.durationDays ? `${medicine.durationDays} days` : '']
        .filter(Boolean)
        .join(' &middot; ');
      const urdu = bilingual ? medicineInstruction(medicine, 'ur') : '';
      return `<li>
        <div class="medicine-name">${escape(line)}</div>
        <div class="medicine-dose">${dose}</div>
        <div class="medicine-note">${escape(medicineInstruction(medicine, 'en'))}</div>
        ${urdu ? `<div class="medicine-note-ur" dir="rtl" lang="ur">${escape(urdu)}</div>` : ''}
      </li>`;
    })
    .join('')}</ol>`;

const listHtml = (items: TextItem[]): string => `<ul>${items.map((item) => `<li>${escape(item.text)}</li>`).join('')}</ul>`;

const sectionsHtml = (sections: PrescriptionSections, bilingual: boolean): string => {
  const blocks = LIST_SECTIONS.filter((section) => sections[section].length > 0).map((section) => {
    const title = SECTION_TITLES[section];
    const heading = bilingual
      ? `${escape(title.en)} <span dir="rtl" lang="ur">${escape(title.ur)}</span>`
      : escape(title.en);
    const body =
      section === 'medicines' ? medicinesHtml(sections.medicines, bilingual) : listHtml(sections[section] as TextItem[]);
    return `<section class="section ${section}"><h3>${heading}</h3>${body}</section>`;
  });

  const { followUp } = sections;
  if (followUp.inDays !== null || followUp.date !== null || followUp.note) {
    const when = followUp.date ?? (followUp.inDays !== null ? `in ${followUp.inDays} days` : '');
    blocks.push(
      `<section class="section follow-up"><h3>Follow up</h3><p>${escape([when, followUp.note].filter(Boolean).join(' - '))}</p></section>`,
    );
  }

  return blocks.join('');
};

/**
 * The print document: one A4 page, letterhead at the top, sections below.
 *
 * Built from the prescription's own letterheadSnapshot and never from the live
 * location, so a clinic that changes its address tomorrow does not change a
 * page that was printed today.
 */
export interface RenderOptions {
  /**
   * A preview of something not yet signed. Marked so a page that reaches a
   * pharmacy by accident cannot be mistaken for a prescription, and with no
   * number, because a draft has not been given one.
   */
  draft?: boolean;
  /**
   * The letterhead to print. A draft has no frozen snapshot yet, so a preview
   * passes the live one; an approved prescription passes nothing and gets the
   * snapshot it was signed with.
   */
  letterhead?: LetterheadSnapshot;
}

export const prescriptionHtml = (
  prescription: PrescriptionDoc,
  patientName: string,
  patientAge: number | null,
  options: RenderOptions = {},
): string => {
  const bilingual = prescription.printLanguage === 'en_ur';
  const snapshot = options.letterhead ??
    prescription.letterheadSnapshot ?? {
      locationName: '',
      address: '',
      phone: '',
      timings: [],
      letterhead: { en: '', ur: '' },
      doctorName: '',
      qualifications: [],
      speciality: '',
      pmdcNo: '',
    };
  const sections = wireSections(prescription.sections);
  const isDraft = options.draft === true;

  return `<!doctype html>
<html lang="${bilingual ? 'en' : 'en'}">
  <head>
    <meta charset="utf-8" />
    <title>${escape(prescription.number ?? 'Prescription')}</title>
    <style>
      @page { size: A4; margin: 14mm 14mm 18mm; }
      * { box-sizing: border-box; }
      body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; font-size: 11pt; margin: 0; }
      .letterhead { display: flex; justify-content: space-between; gap: 12mm; border-bottom: 2px solid #111; padding-bottom: 4mm; }
      .letterhead h1 { font-size: 16pt; margin: 0; }
      .letterhead h2 { font-size: 12pt; margin: 0; }
      .letterhead p { margin: 1mm 0; font-size: 9pt; color: #444; }
      .speciality { font-style: italic; }
      .clinic { text-align: right; }
      .clinic-ur { font-size: 12pt; }
      .patient { display: flex; gap: 8mm; margin: 5mm 0; font-size: 10pt; }
      .patient strong { font-weight: 600; }
      .section { margin-bottom: 4mm; break-inside: avoid; }
      .section h3 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.4pt; color: #333; margin: 0 0 1.5mm; }
      .section ul, .section ol { margin: 0; padding-left: 6mm; }
      .section li { margin-bottom: 1mm; }
      .medicines li { margin-bottom: 2.5mm; }
      .medicine-name { font-weight: 600; }
      .medicine-dose { font-size: 9.5pt; color: #333; }
      .medicine-note { font-size: 9pt; color: #555; }
      .medicine-note-ur { font-size: 11pt; }
      footer { position: fixed; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-between; font-size: 8pt; color: #666; border-top: 1px solid #ccc; padding-top: 2mm; }
      .draft-band { background: #b00020; color: #fff; font-weight: 700; letter-spacing: 1pt; text-align: center; padding: 2mm; margin-bottom: 4mm; font-size: 10pt; }
      .draft-mark { position: fixed; top: 45%; left: 0; right: 0; text-align: center; font-size: 56pt; font-weight: 800; color: rgba(176, 0, 32, 0.12); transform: rotate(-24deg); letter-spacing: 6pt; pointer-events: none; }
    </style>
  </head>
  <body>
    ${isDraft ? '<div class="draft-mark">DRAFT</div>' : ''}
    ${isDraft ? '<div class="draft-band">DRAFT &mdash; NOT VALID. This prescription has not been approved or signed.</div>' : ''}
    ${letterheadHtml(snapshot, bilingual)}
    <div class="patient">
      <span><strong>${escape(patientName)}</strong></span>
      ${patientAge !== null ? `<span>${patientAge} yrs</span>` : ''}
      <span>${prescription.approvedAt ? prescription.approvedAt.toISOString().slice(0, 10) : ''}</span>
      <span>${isDraft ? '' : escape(prescription.number ?? '')}</span>
    </div>
    ${sectionsHtml(sections, bilingual)}
    <footer>
      <span>${isDraft ? 'DRAFT' : escape(prescription.number ?? '')} &middot; v${prescription.version}</span>
      <span>${escape(snapshot.doctorName)}</span>
    </footer>
  </body>
</html>`;
};

/**
 * Render and store the print file, returning its object key.
 *
 * With PDF_RENDERER_URL set, the HTML is posted to that service and the PDF it
 * returns is stored. Without one, the HTML itself is stored: a print file that
 * a browser can open is worth more than no print file, and the key's extension
 * tells the app which it got. Runs in process, after approval, and the app
 * polls for the key.
 */
export const renderPrescription = async (
  prescription: PrescriptionDoc,
  patientName: string,
  patientAge: number | null,
): Promise<string> => {
  const html = prescriptionHtml(prescription, patientName, patientAge);

  if (config.pdf.rendererUrl) {
    try {
      const response = await fetch(config.pdf.rendererUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
        body: html,
      });
      if (!response.ok) {
        throw new Error(`renderer answered ${response.status}`);
      }
      const pdf = Buffer.from(await response.arrayBuffer());
      const key = prescriptionPdfKey(prescription.practiceId, prescription._id, prescription.version, 'pdf');
      await put(key, pdf, 'application/pdf');
      return key;
    } catch (error) {
      logger.error(`pdf renderer failed for prescription ${String(prescription._id)}: ${(error as Error).message}`);
    }
  }

  const key = prescriptionPdfKey(prescription.practiceId, prescription._id, prescription.version, 'html');
  await put(key, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
  return key;
};

/**
 * Render a draft so the doctor can see what will print before signing it.
 *
 * Never written to the prescription's pdfKey: that file is the approved
 * document, and a preview of an unsigned draft must not be able to become it.
 * The key carries the version and the moment the draft last changed, so asking
 * twice for an unchanged draft reuses one object and an edited draft gets a
 * fresh URL rather than a stale page.
 */
export const renderPreview = async (
  prescription: PrescriptionDoc,
  patientName: string,
  patientAge: number | null,
  letterhead: LetterheadSnapshot,
): Promise<string> => {
  const draft = prescription.status === 'draft';
  const html = prescriptionHtml(prescription, patientName, patientAge, {
    draft,
    // An approved prescription previews exactly as it was signed.
    ...(draft ? { letterhead } : {}),
  });
  const stamp = prescription.updatedAt.getTime();

  if (config.pdf.rendererUrl) {
    try {
      const response = await fetch(config.pdf.rendererUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
        body: html,
      });
      if (!response.ok) {
        throw new Error(`renderer answered ${response.status}`);
      }
      const pdf = Buffer.from(await response.arrayBuffer());
      const key = prescriptionPreviewKey(prescription.practiceId, prescription._id, prescription.version, stamp, 'pdf');
      await put(key, pdf, 'application/pdf');
      return key;
    } catch (error) {
      logger.error(`pdf renderer failed previewing prescription ${String(prescription._id)}: ${(error as Error).message}`);
    }
  }

  const key = prescriptionPreviewKey(prescription.practiceId, prescription._id, prescription.version, stamp, 'html');
  await put(key, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
  return key;
};

export default { renderPrescription, renderPreview, prescriptionHtml };
