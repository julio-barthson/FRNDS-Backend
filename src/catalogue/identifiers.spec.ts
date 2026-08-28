import {
  checkIsrc,
  checkUpc,
  describeIdentifierClash,
  hasValidGs1CheckDigit,
} from './identifiers';

function value(result: ReturnType<typeof checkIsrc>): string | null {
  return 'value' in result ? result.value : null;
}

function problem(result: ReturnType<typeof checkIsrc>): string | null {
  return 'message' in result ? result.message : null;
}

describe('checkIsrc', () => {
  it('accepts a well-formed code and stores it without separators', () => {
    expect(value(checkIsrc('GB-AYE-00-00001'))).toBe('GBAYE0000001');
  });

  it('uppercases and tolerates spaces', () => {
    expect(value(checkIsrc(' gbaye 00 00001 '))).toBe('GBAYE0000001');
  });

  it('allows digits in the registrant, which is alphanumeric', () => {
    expect(value(checkIsrc('US4R30900001'))).toBe('US4R30900001');
  });

  it('treats empty as cleared rather than invalid', () => {
    expect(value(checkIsrc('   '))).toBe('');
  });

  it('rejects a country code that is not two letters', () => {
    expect(problem(checkIsrc('1BAYE0000001'))).toMatch(/ISRC looks like/);
  });

  it('rejects the wrong length', () => {
    expect(problem(checkIsrc('GBAYE000001'))).toMatch(/ISRC looks like/);
  });

  it('rejects letters where the year and designation belong', () => {
    expect(problem(checkIsrc('GBAYEZZ00001'))).toMatch(/ISRC looks like/);
  });
});

describe('hasValidGs1CheckDigit', () => {
  // Weighting runs 3,1 from the right, so it has to hold across lengths.
  it('accepts a known-good UPC-A', () => {
    expect(hasValidGs1CheckDigit('036000291452')).toBe(true);
  });

  it('accepts a known-good EAN-13', () => {
    expect(hasValidGs1CheckDigit('4006381333931')).toBe(true);
  });

  it('rejects a single wrong digit', () => {
    expect(hasValidGs1CheckDigit('036000291453')).toBe(false);
  });

  it('rejects a transposition, which a length check would miss', () => {
    expect(hasValidGs1CheckDigit('036000219452')).toBe(false);
  });
});

describe('checkUpc', () => {
  it('accepts a valid barcode and strips separators', () => {
    expect(value(checkUpc('0-36000-29145-2'))).toBe('036000291452');
  });

  it('treats empty as cleared', () => {
    expect(value(checkUpc(''))).toBe('');
  });

  it('rejects letters', () => {
    expect(problem(checkUpc('03600029145X'))).toMatch(/12 to 14 digits/);
  });

  it('rejects the wrong length', () => {
    expect(problem(checkUpc('03600029'))).toMatch(/12 to 14 digits/);
  });

  it('names the check digit when the length is right but a digit is wrong', () => {
    expect(problem(checkUpc('036000291453'))).toMatch(/check digit/);
  });
});

describe('describeIdentifierClash', () => {
  /**
   * The real thing, captured from a duplicate barcode against Neon. Two traps
   * live in it: `meta.target` is absent (the driver adapter does not set it),
   * and Prisma embeds a source excerpt of the call site — which mentions a
   * variable called `trackIsrcs`. A substring search over this message reports
   * a barcode clash as an ISRC clash.
   */
  const realUpcClash = {
    code: 'P2002',
    message: [
      '',
      'Invalid `this.prisma.release.create()` invocation in',
      'at releases.service.js:67:76',
      '',
      '  65 const upc = (0, identifiers_1.upcForStorage)(dto.upc);',
      '  66 const trackIsrcs = dto.tracks.map((track) => (0, identifiers_1.isrcForStorage)(track.isrc));',
      '→ 67 const release = await this.createOrClash(() => this.prisma.release.create(',
      'Unique constraint failed on the fields: (`upc`)',
    ].join(String.fromCharCode(10)),
    meta: {
      modelName: 'Release',
      driverAdapterError: 'DriverAdapterError: UniqueConstraintViolation',
    },
  };

  it('names the barcode despite the excerpt mentioning trackIsrcs', () => {
    expect(describeIdentifierClash(realUpcClash)).toMatch(/barcode is already/);
  });

  it('names the ISRC when that is the field that clashed', () => {
    expect(
      describeIdentifierClash({
        ...realUpcClash,
        message: realUpcClash.message.replace(
          'fields: (`upc`)',
          'fields: (`isrc`)',
        ),
      }),
    ).toMatch(/ISRC is already/);
  });

  it('still reads meta.target, which a plain client does populate', () => {
    expect(
      describeIdentifierClash({ code: 'P2002', meta: { target: ['isrc'] } }),
    ).toMatch(/ISRC is already/);
  });

  it('ignores a unique violation on some other column', () => {
    expect(
      describeIdentifierClash({
        code: 'P2002',
        message: 'Unique constraint failed on the fields: (`slug`)',
        meta: { modelName: 'Artist' },
      }),
    ).toBeNull();
  });

  it('ignores anything that is not P2002', () => {
    expect(describeIdentifierClash(new Error('connection reset'))).toBeNull();
    expect(describeIdentifierClash(null)).toBeNull();
  });
});
