import { strToU8, zipSync } from 'fflate';

// File Word/Excel trống tối thiểu nhưng hợp lệ (Office và LibreOffice mở được).

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function contentTypes(overrides: [string, string][]): string {
  return (
    XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
    '</Types>'
  );
}

function rels(id: string, type: string, target: string): string {
  return XML + `<Relationships xmlns="${REL_NS}"><Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`;
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

export function emptyDocx(): Uint8Array {
  return zip({
    '[Content_Types].xml': contentTypes([
      ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ]),
    '_rels/.rels': rels('rId1', `${OFFICE_DOC_REL}/officeDocument`, 'word/document.xml'),
    'word/document.xml':
      XML +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
  });
}

export function emptyXlsx(): Uint8Array {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zip({
    '[Content_Types].xml': contentTypes([
      ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
      ['/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'],
    ]),
    '_rels/.rels': rels('rId1', `${OFFICE_DOC_REL}/officeDocument`, 'xl/workbook.xml'),
    'xl/workbook.xml':
      XML +
      `<workbook xmlns="${ns}" xmlns:r="${OFFICE_DOC_REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels('rId1', `${OFFICE_DOC_REL}/worksheet`, 'worksheets/sheet1.xml'),
    'xl/worksheets/sheet1.xml': XML + `<worksheet xmlns="${ns}"><sheetData/></worksheet>`,
  });
}
