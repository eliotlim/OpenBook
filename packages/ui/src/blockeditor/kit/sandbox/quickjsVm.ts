import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import type {EvalRequest, EvalResult} from '../scope';
import {isEvalResult, prepareEvalRequest} from './scopeMarshal';

export const QUICKJS_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
export const QUICKJS_STACK_LIMIT_BYTES = 512 * 1024;
export const QUICKJS_TIMEOUT_MS = 25;
export const QUICKJS_COMPILED_CACHE_SIZE = 256;
export const UNSUPPORTED_RESULT_ERROR = 'Sandbox result is not a supported structured-clone value';

interface CompiledSource {
  expression?: QuickJSHandle;
  code?: QuickJSHandle;
  expressionError?: string;
  codeError?: string;
}

interface VmState {
  runtime: QuickJSRuntime;
  context: QuickJSContext;
  cache: Map<string, CompiledSource>;
  arrayIsArray: QuickJSHandle;
  objectGetPrototypeOf: QuickJSHandle;
  objectPrototype: QuickJSHandle;
}

interface QuickJSEvaluatorOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  stackLimitBytes?: number;
  cacheSize?: number;
}

const errorMessage = (context: QuickJSContext, handle: QuickJSHandle): string => {
  const dumped = context.dump(handle) as {name?: unknown; message?: unknown} | string;
  if (typeof dumped === 'string') return dumped;
  const name = typeof dumped?.name === 'string' ? dumped.name : '';
  const message = typeof dumped?.message === 'string' ? dumped.message : String(dumped);
  return name && name !== 'Error' ? `${name}: ${message}` : message;
};

const isCapacityError = (message: string): boolean => /out of memory|interrupted|stack overflow/i.test(message);

let quickJSModule: Promise<QuickJSWASMModule> | undefined;

const releaseVariant = async (): Promise<typeof RELEASE_SYNC> => {
  if (import.meta.env.MODE !== 'test') return RELEASE_SYNC;
  // Emscripten's browser loader tries to open Vite's development URL through
  // Node's filesystem in Vitest. Tests receive the same WASM bytes explicitly;
  // production lets Vite bundle the variant's normal URL exactly once.
  const {default: quickJSWasmUrl} = await import('@jitl/quickjs-wasmfile-release-sync/wasm?url&inline');
  return newVariant(RELEASE_SYNC, {
    locateFile: () => quickJSWasmUrl,
    wasmBinary: async () => {
      const response = await fetch(quickJSWasmUrl);
      if (!response.ok) throw new Error(`Unable to load QuickJS WASM (${response.status})`);
      return response.arrayBuffer();
    },
  });
};

const loadQuickJSModule = (): Promise<QuickJSWASMModule> => {
  quickJSModule ??= releaseVariant().then((variant) => newQuickJSWASMModuleFromVariant(variant));
  return quickJSModule;
};

/** A resident QuickJS runtime. The Worker owns one instance for its lifetime. */
export class QuickJSEvaluator {
  private state: VmState;
  private deadline = Number.POSITIVE_INFINITY;
  private compileTotal = 0;

  private constructor(
    private readonly module: QuickJSWASMModule,
    private readonly options: Required<QuickJSEvaluatorOptions>,
  ) {
    this.state = this.createState();
  }

  static async create(options: QuickJSEvaluatorOptions = {}): Promise<QuickJSEvaluator> {
    const module = await loadQuickJSModule();
    return new QuickJSEvaluator(module, {
      timeoutMs: options.timeoutMs ?? QUICKJS_TIMEOUT_MS,
      memoryLimitBytes: options.memoryLimitBytes ?? QUICKJS_MEMORY_LIMIT_BYTES,
      stackLimitBytes: options.stackLimitBytes ?? QUICKJS_STACK_LIMIT_BYTES,
      cacheSize: options.cacheSize ?? QUICKJS_COMPILED_CACHE_SIZE,
    });
  }

  get compiledSourceCount(): number {
    return this.compileTotal;
  }

  get cachedSourceCount(): number {
    return this.state.cache.size;
  }

  async evaluate(rawRequest: EvalRequest): Promise<EvalResult> {
    if (!rawRequest.source.trim()) return {value: undefined};
    const prepared = prepareEvalRequest(rawRequest);
    if (isEvalResult(prepared)) return prepared;

    const {context, runtime} = this.state;
    this.deadline = Date.now() + this.options.timeoutMs;
    runtime.setInterruptHandler(() => Date.now() >= this.deadline);
    let capacityFailure = false;
    try {
      const compiled = this.compiledFunction(prepared.kind, prepared.source);
      if (typeof compiled === 'string') {
        capacityFailure = isCapacityError(compiled);
        return {error: this.normaliseError(compiled)};
      }
      const scope = this.toQuickJS(prepared.scope);
      try {
        const call = context.callFunction(compiled, context.undefined, scope);
        if (call.error) {
          const message = errorMessage(context, call.error);
          call.error.dispose();
          capacityFailure = isCapacityError(message);
          return {error: this.normaliseError(message)};
        }
        if (!call.value) return {error: 'QuickJS returned no value'};
        try {
          return {value: this.fromQuickJS(call.value, [])};
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          capacityFailure = isCapacityError(message);
          return {error: this.normaliseError(message)};
        } finally {
          call.value.dispose();
        }
      } finally {
        scope.dispose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      capacityFailure = isCapacityError(message);
      return {error: this.normaliseError(message)};
    } finally {
      this.deadline = Number.POSITIVE_INFINITY;
      runtime.removeInterruptHandler();
      if (capacityFailure) this.reset();
    }
  }

  dispose(): void {
    this.disposeState(this.state);
  }

  private createState(): VmState {
    const runtime = this.module.newRuntime();
    runtime.setMemoryLimit(this.options.memoryLimitBytes);
    runtime.setMaxStackSize(this.options.stackLimitBytes);
    const context = runtime.newContext();
    const array = context.getProp(context.global, 'Array');
    const arrayIsArray = context.getProp(array, 'isArray');
    array.dispose();
    const object = context.getProp(context.global, 'Object');
    const objectGetPrototypeOf = context.getProp(object, 'getPrototypeOf');
    const objectPrototype = context.getProp(object, 'prototype');
    object.dispose();
    return {runtime, context, cache: new Map(), arrayIsArray, objectGetPrototypeOf, objectPrototype};
  }

  private reset(): void {
    const previous = this.state;
    this.state = this.createState();
    this.disposeState(previous);
  }

  private disposeState(state: VmState): void {
    for (const entry of state.cache.values()) {
      entry.expression?.dispose();
      if (entry.code !== entry.expression) entry.code?.dispose();
    }
    state.arrayIsArray.dispose();
    state.objectGetPrototypeOf.dispose();
    state.objectPrototype.dispose();
    state.context.dispose();
    state.runtime.dispose();
  }

  private compiledFunction(kind: EvalRequest['kind'], source: string): QuickJSHandle | string {
    const {cache} = this.state;
    let entry = cache.get(source);
    if (entry) {
      cache.delete(source);
      cache.set(source, entry);
    } else {
      entry = {};
      cache.set(source, entry);
      while (cache.size > this.options.cacheSize) {
        const oldestKey = cache.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        const oldest = cache.get(oldestKey);
        oldest?.expression?.dispose();
        if (oldest?.code !== oldest?.expression) oldest?.code?.dispose();
        cache.delete(oldestKey);
      }
    }

    if (kind === 'expression') {
      if (entry.expression) return entry.expression;
      if (entry.expressionError) return entry.expressionError;
      const result = this.compile(source, true);
      if (typeof result === 'string') entry.expressionError = result;
      else entry.expression = result;
      return result;
    }

    if (entry.code) return entry.code;
    if (entry.codeError) return entry.codeError;
    if (entry.expression) {
      entry.code = entry.expression;
      return entry.code;
    }
    const expression = this.compile(source, true);
    if (typeof expression !== 'string') {
      entry.expression = expression;
      entry.code = expression;
      return expression;
    }
    entry.expressionError = expression;
    if (isCapacityError(expression)) return expression;
    const body = this.compile(source, false);
    if (typeof body === 'string') entry.codeError = body;
    else entry.code = body;
    return body;
  }

  private compile(source: string, expression: boolean): QuickJSHandle | string {
    const body = expression ? `return (${source});` : source;
    const wrapped = `(function(__openbookScope){const scope=__openbookScope;with(__openbookScope){${body}\n}})`;
    const result = this.state.context.evalCode(wrapped, 'openbook-eval.js');
    this.compileTotal += 1;
    if (result.error) {
      const message = errorMessage(this.state.context, result.error);
      result.error.dispose();
      return message;
    }
    return result.value;
  }

  private toQuickJS(value: unknown): QuickJSHandle {
    const {context} = this.state;
    if (value === undefined) return context.undefined.dup();
    if (value === null) return context.null.dup();
    if (typeof value === 'boolean') return (value ? context.true : context.false).dup();
    if (typeof value === 'number') return context.newNumber(value);
    if (typeof value === 'string') return context.newString(value);
    if (Array.isArray(value)) {
      const array = context.newArray();
      value.forEach((item, index) => {
        const handle = this.toQuickJS(item);
        context.setProp(array, index, handle);
        handle.dispose();
      });
      return array;
    }
    const object = context.newObject();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const handle = this.toQuickJS(item);
      context.setProp(object, key, handle);
      handle.dispose();
    }
    return object;
  }

  private fromQuickJS(handle: QuickJSHandle, ancestors: QuickJSHandle[]): unknown {
    const {context, arrayIsArray, objectGetPrototypeOf, objectPrototype} = this.state;
    const type = context.typeof(handle);
    if (type === 'undefined') return undefined;
    if (type === 'boolean') return context.sameValue(handle, context.true);
    if (type === 'number') return context.getNumber(handle);
    if (type === 'string') return context.getString(handle);
    if (type !== 'object' || context.sameValue(handle, context.null)) {
      if (context.sameValue(handle, context.null)) return null;
      throw new Error(`${UNSUPPORTED_RESULT_ERROR}: ${type}`);
    }
    if (ancestors.some((ancestor) => context.sameValue(handle, ancestor))) {
      throw new Error(`${UNSUPPORTED_RESULT_ERROR}: cyclic object`);
    }
    const nextAncestors = [...ancestors, handle];
    const arrayCheck = context.callFunction(arrayIsArray, context.undefined, handle);
    if (arrayCheck.error) {
      const message = errorMessage(context, arrayCheck.error);
      arrayCheck.error.dispose();
      throw new Error(message);
    }
    if (!arrayCheck.value) throw new Error(`${UNSUPPORTED_RESULT_ERROR}: array check failed`);
    const isArray = context.sameValue(arrayCheck.value, context.true);
    arrayCheck.value.dispose();
    if (isArray) {
      const length = context.getLength(handle) ?? 0;
      const array: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = context.getProp(handle, index);
        try {
          array.push(this.fromQuickJS(item, nextAncestors));
        } finally {
          item.dispose();
        }
      }
      return array;
    }

    const prototypeResult = context.callFunction(objectGetPrototypeOf, context.undefined, handle);
    if (prototypeResult.error) {
      const message = errorMessage(context, prototypeResult.error);
      prototypeResult.error.dispose();
      throw new Error(message);
    }
    if (!prototypeResult.value) throw new Error(`${UNSUPPORTED_RESULT_ERROR}: prototype check failed`);
    const isPlain = context.sameValue(prototypeResult.value, objectPrototype)
      || context.sameValue(prototypeResult.value, context.null);
    prototypeResult.value.dispose();
    if (!isPlain) throw new Error(`${UNSUPPORTED_RESULT_ERROR}: non-plain object`);

    const names = context.unwrapResult(context.getOwnPropertyNames(handle, {
      strings: true,
      numbersAsStrings: true,
      symbols: true,
      onlyEnumerable: true,
    }));
    const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    try {
      for (const nameHandle of names) {
        if (context.typeof(nameHandle) === 'symbol') throw new Error(`${UNSUPPORTED_RESULT_ERROR}: symbol key`);
        const name = context.getString(nameHandle);
        const item = context.getProp(handle, nameHandle);
        try {
          Object.defineProperty(object, name, {
            value: this.fromQuickJS(item, nextAncestors),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } finally {
          item.dispose();
        }
      }
    } finally {
      names.dispose();
    }
    return object;
  }

  private normaliseError(message: string): string {
    if (/interrupted/i.test(message)) return `Evaluation timed out after ${this.options.timeoutMs} ms`;
    if (/out of memory/i.test(message)) return `Evaluation exceeded the ${Math.round(this.options.memoryLimitBytes / 1024 / 1024)} MiB memory limit`;
    return message;
  }
}
