export class SpikeFailure extends Error {
  constructor(stage, code, status) {
    super(code);
    this.stage = stage;
    this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}
