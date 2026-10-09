import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { comparableLines, pptxParagraphs } from '../src/docText.js';

const slide = (...paras: string[]) =>
  strToU8(`<p:sld><p:cSld><p:spTree>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`);

describe('pptxParagraphs', () => {
  it('chữ từng slide theo đúng thứ tự (slide 10 sau slide 2), kèm ghi chú người thuyết trình', () => {
    const data = zipSync({
      'ppt/slides/slide10.xml': slide('Kết luận'),
      'ppt/slides/slide2.xml': slide('Hai pha', 'Pha sáng &amp; pha tối'),
      'ppt/slides/slide1.xml': slide('Quang hợp'),
      'ppt/notesSlides/notesSlide1.xml': slide('Hỏi học sinh trước'),
    });
    expect(pptxParagraphs(data)).toEqual([
      'Slide 1: Quang hợp',
      'Slide 1 (ghi chú): Hỏi học sinh trước',
      'Slide 2: Hai pha',
      'Slide 2: Pha sáng & pha tối',
      'Slide 10: Kết luận',
    ]);
    expect(comparableLines('bai-giang.pptx', data)).toHaveLength(5);
  });
});
