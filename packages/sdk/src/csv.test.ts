/**
 * The shared RFC-4180 reader.
 *
 * The QUOTING corpus lives with its original owner (`notionImport.test.ts` —
 * quoted commas, doubled quotes, embedded newlines) and still runs against this
 * module through the re-export, which is the point of the extraction. What is
 * pinned here is the behaviour the BANK importer added: BOM/CRLF/ragged
 * tolerance, and the size limits that make an untrusted upload safe to parse.
 */

import {describe, expect, it} from 'vitest';
import {CsvLimitError, parseCsv} from './csv';
import {parseCsv as parseCsvViaNotion} from './notionImport';

describe('parseCsv — shared reader', () => {
  it('is the SAME function the notion importer exports (one parser, not two)', () => {
    expect(parseCsvViaNotion).toBe(parseCsv);
  });

  it('tolerates BOM, CRLF, ragged rows and an unterminated quote', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    // Ragged rows come back ragged: the CALLER decides whether a short row is
    // an error, because for a bank statement it usually is not.
    expect(parseCsv('a,b,c\n1,2\n3,4,5,6')).toEqual([['a', 'b', 'c'], ['1', '2'], ['3', '4', '5', '6']]);
    // A half-broken file still yields the rows it could read.
    expect(parseCsv('a,b\n"unterminated,2')).toEqual([['a', 'b'], ['unterminated,2']]);
    // A trailing newline does not invent an empty row.
    expect(parseCsv('a\nb\n')).toEqual([['a'], ['b']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('is unbounded by default (trusted callers are unchanged)', () => {
    const big = `h\n${'x\n'.repeat(5000)}`;
    expect(parseCsv(big)).toHaveLength(5001);
  });

  it('throws CsvLimitError rather than silently importing a prefix', () => {
    // Loudness is the requirement: truncating a bank statement at row 500 would
    // look like a successful import of half the month.
    expect(() => parseCsv('a\nb\nc\n', {maxRows: 2})).toThrow(CsvLimitError);
    expect(() => parseCsv('x'.repeat(50), {maxLength: 10})).toThrow(/too large/);
    expect(() => parseCsv('a,"' + 'y'.repeat(50) + '"', {maxFieldLength: 10})).toThrow(/too long/);
    expect(() => parseCsv('1,2,3,4,5', {maxColumns: 3})).toThrow(/too many columns/);
    // At the limit exactly: accepted.
    expect(parseCsv('a\nb\n', {maxRows: 2, maxLength: 4, maxFieldLength: 1, maxColumns: 1})).toEqual([['a'], ['b']]);
  });
});
