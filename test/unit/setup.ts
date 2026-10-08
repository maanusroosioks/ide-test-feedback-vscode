import { beforeEach } from 'vitest';
import { resetVscodeStub } from './helpers/vscodeStub';

// Registered ahead of each file's own hooks, so a file's beforeEach can build on a clean stub.
beforeEach(() => {
  resetVscodeStub();
});
