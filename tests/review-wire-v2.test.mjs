import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProjectReviewModel, decodeProjectReviewResponseV2, validateProjectReviewResponse, getProjectReviewResponseFeedback, normalizeProjectReviewResponseFeedback, projectReviewEvidenceOrigin } from '../lib/project-review-model.mjs';
import { getModelRequestEvidence } from '../lib/model-request-evidence.mjs';

const files = [{ path: 'src/app.mjs', content: 'export function app() {\n  return "quoted\\value";  \n\n}\n' }];
const clear = { summary: 'Fixed local format fixture', issues: [], resolutions: [] };
const issue = { severity: 'advisory', file: 'src/app.mjs', line: 2, message: 'Inspect the selected line' };
const decode = (raw, previousIssues = []) => decodeProjectReviewResponseV2(JSON.stringify(raw), { files, previousIssues });
const fails = (raw, reason, field, previous = []) => assert.throws(() => decode(raw, previous), error => {
  assert.equal(error.code, 'invalid_model_response'); assert.deepEqual(getProjectReviewResponseFeedback(error), { version: 1, reason, field }); return true;
});

test('wire v2 derives literal evidence from the selected fixed source and keeps the strict normalized validator', () => {
  const result = decode({ ...clear, issues: [issue] });
  assert.deepEqual(result, { ...clear, issues: [{ ...issue, evidence: 'return "quoted\\value";' }], evidenceOrigin: projectReviewEvidenceOrigin });
  assert.deepEqual(validateProjectReviewResponse(result, { files }), { ...clear, issues: result.issues });
  assert.throws(() => validateProjectReviewResponse({ ...result, issues: [{ ...result.issues[0], evidence: 'invented' }] }, { files }), /证据/u);
  // The location remains the model's choice, not a claim that it copied a line.
  const other = decode({ ...clear, issues: [{ ...issue, line: 1 }] });
  assert.equal(other.issues[0].line, 1); assert.equal(other.issues[0].evidence, files[0].content.split('\n')[0]);
});

test('v2 rejects unknown fields, missing required fields, invalid ranges and blank source lines', () => {
  for (const key of ['passed', 'status', 'binding', 'reviewWireVersion', 'evidenceOrigin']) fails({ ...clear, [key]: true }, 'unknown_fields', '$');
  fails({ summary: 'missing', issues: [] }, 'missing_fields', '$');
  fails({ ...clear, issues: [{ ...issue, evidence: 'model supplied' }] }, 'unknown_fields', 'issues[0]');
  fails({ ...clear, issues: [{ ...issue, file: '../outside.mjs' }] }, 'invalid_location', 'issues[0].file');
  for (const line of [0, -1, 3, 5, 6, 1.2, '2']) fails({ ...clear, issues: [{ ...issue, line }] }, 'invalid_location', 'issues[0].line');
  fails({ ...clear, issues: [{ ...issue, severity: 'pass' }] }, 'invalid_field', 'issues[0].severity');
  fails({ ...clear, issues: [{ ...issue, message: '' }] }, 'invalid_field', 'issues[0].message');
  fails({ ...clear, resolutions: [{ id: 'old', status: 'resolved', reason: 'x', evidence: 'extra' }] }, 'unknown_fields', 'resolutions[0]');
});

test('v2 requires exactly all original blocking IDs and does not drop a valid blocking opinion', () => {
  const prior = [{ id: 'old-1' }, { id: 'old-2' }], resolution = id => ({ id, status: 'open', reason: 'Still requires a real fix' });
  fails(clear, 'invalid_resolutions', 'resolutions', prior);
  fails({ ...clear, resolutions: [resolution('old-1'), resolution('old-1')] }, 'invalid_resolutions', 'resolutions[1].id', prior);
  fails({ ...clear, resolutions: [resolution('foreign')] }, 'invalid_resolutions', 'resolutions[0].id', prior);
  const result = decode({ ...clear, issues: [{ ...issue, severity: 'blocking', message: 'The words nonblocking here cannot override severity' }], resolutions: prior.map(v => resolution(v.id)) }, prior);
  assert.equal(result.issues[0].severity, 'blocking'); assert.equal(result.resolutions.length, 2);
});

test('safe format diagnostics never expose arbitrary model strings and reject local feedback accessors before use', () => {
  let error;try { decodeProjectReviewResponseV2('{"issues":[]},"summary":"private marker"', { files }); } catch (value) { error = value; }
  const feedback = getProjectReviewResponseFeedback(error); assert.equal(feedback.reason, 'invalid_json'); assert.equal(feedback.field, '$');
  assert.equal(JSON.stringify(feedback).includes('private'), false); assert.equal(error.message.includes('private'), false);
  assert.deepEqual(normalizeProjectReviewResponseFeedback(feedback), feedback);
  assert.equal(getProjectReviewResponseFeedback({ code: 'invalid_model_response', responseFeedback: feedback }), null);
  let invoked = 0; const getter = { version: 1, field: '$', get reason() { invoked++; return 'invalid_json'; } };
  for (const raw of [getter, { ...feedback, reason: 'private raw error' }, { ...feedback, field: 'src/private/path' }, { ...feedback, position: -1 }, { ...feedback, extra: 'data' }, { reason: 'invalid_json', field: '$' }]) assert.throws(() => normalizeProjectReviewResponseFeedback(raw));
  assert.equal(invoked, 0);
});

test('real localhost native Review preserves raw v2 receipt and sends only controlled feedback on an explicit second call', async t => {
  const requests = [], responses = ['{"summary":', JSON.stringify({ ...clear, issues: [issue] })];
  const server = http.createServer(async (req, res) => { let text = ''; for await (const chunk of req) text += chunk; requests.push(JSON.parse(text)); const content = responses.shift(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 2, completion_tokens: 3 } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixed-local-review', apiKey: '', thinking: 'disabled', jsonMode: true };
  const native = createProjectReviewModel({ config }), receipts = []; let failure;
  await assert.rejects(native({ task: 'Public local fixture', files, onReceipt: value => receipts.push(value) }), error => { failure = error; return true; });
  assert.equal(requests.length, 1, 'adapter never retries by itself'); assert.deepEqual(getModelRequestEvidence(failure), { dispatched: true, responseComplete: true });
  const responseFeedback = getProjectReviewResponseFeedback(failure);
  const result = await native({ task: 'Public local fixture', files, responseFeedback, onReceipt: value => receipts.push(value) });
  assert.equal(requests.length, 2); assert.deepEqual(JSON.parse(requests[1].messages[1].content).responseFeedback, responseFeedback);
  assert.equal(receipts[0].content, '{"summary":'); assert.equal(receipts[0].reviewWireVersion, 2); assert.equal(receipts[1].reviewWireVersion, 2);
  assert.equal(result.evidenceOrigin, projectReviewEvidenceOrigin); assert.equal(result.issues[0].evidence, files[0].content.split('\n')[1].trim());
  for (const request of requests) { assert.equal(request.max_tokens, 4096); assert.deepEqual(request.thinking, { type: 'disabled' }); assert.deepEqual(request.response_format, { type: 'json_object' }); }
});
