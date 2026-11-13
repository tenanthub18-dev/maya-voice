import {describe, expect, it, vi} from 'vitest';

describe('test-call microphone', () => {
  it.each([
    [false, undefined, 'insecure-context'],
    [true, undefined, 'no-device'],
  ] as const)('maps unavailable browser states to a useful error', async (secure, mediaDevices, code) => {
    const {requestTestCallMicrophone} = await import('@/lib/testcall/microphone');
    await expect(requestTestCallMicrophone({isSecureContext: secure, mediaDevices})).rejects.toMatchObject({code});
  });

  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotFoundError', 'no-device'],
  ] as const)('maps %s to %s', async (name, code) => {
    const {requestTestCallMicrophone} = await import('@/lib/testcall/microphone');
    const error = new DOMException('microphone', name);
    const mediaDevices = {getUserMedia: vi.fn().mockRejectedValue(error)};
    await expect(requestTestCallMicrophone({isSecureContext: true, mediaDevices})).rejects.toMatchObject({code});
  });

  it('requests audio only when the browser can provide it', async () => {
    const {requestTestCallMicrophone} = await import('@/lib/testcall/microphone');
    const stream = {} as MediaStream;
    const mediaDevices = {getUserMedia: vi.fn().mockResolvedValue(stream)};
    await expect(requestTestCallMicrophone({isSecureContext: true, mediaDevices})).resolves.toBe(stream);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({audio: true, video: false});
  });
});
