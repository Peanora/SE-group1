import path from 'node:path';

export const FACTORY_VERSION = '1.0.5';
export const FACTORY_EXECUTABLE = process.platform === 'win32' ? 'factory.exe' : 'factory';

export function factoryBinaryPath(root) {
  return path.join(root, 'output', 'factory-runtime', FACTORY_EXECUTABLE);
}
