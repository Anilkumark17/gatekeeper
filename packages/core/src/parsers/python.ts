import type { Node, LanguageParser } from './runtime.js';
import type { FileParse } from '../types.js';
import { nn, SymbolCollector, bodySig, firstLine, pos, EVENT_METHODS, ORM_METHODS, SERVICE_FUNCS } from './util.js';

interface Ctx {
  cur: string;
  cls: string;
}

export const python: LanguageParser = {
  id: 'python',
  extensions: ['.py'],
  grammarFor: () => 'python',
  extract(root: Node, source: string): FileParse {
    const c = new SymbolCollector('python', source.split('\n').length);
    const out = c.out;

    const def = (kind: 'class' | 'function' | 'data', name: string, node: Node, nameNode: Node | null, ctx: Ctx, qname: string) => {
      const p = pos(node);
      c.add({
        qname,
        type: kind,
        name,
        line: p.line,
        endLine: p.endLine,
        col: nameNode ? nameNode.startPosition.column : p.col,
        parent: ctx.cls || undefined,
        exported: !name.startsWith('_'),
        sig: bodySig(node.text, name),
        signature: firstLine(node.text),
      });
    };

    const handleImportFrom = (node: Node) => {
      const mod = node.childForFieldName('module_name');
      if (!mod) return;
      const m = /^(\.*)(.*)$/.exec(mod.text)!;
      const bindings: { local: string; imported: string }[] = [];
      for (const ch of node.namedChildren.filter(nn)) {
        if (ch === mod) continue;
        if (ch.type === 'dotted_name') bindings.push({ local: ch.text, imported: ch.text });
        else if (ch.type === 'aliased_import') {
          const nm = ch.childForFieldName('name')!;
          const al = ch.childForFieldName('alias');
          bindings.push({ local: (al ?? nm).text, imported: nm.text });
        } else if (ch.type === 'wildcard_import') bindings.push({ local: '*', imported: '*' });
      }
      out.imports.push({ spec: m[2], level: m[1].length, bindings, line: node.startPosition.row + 1 });
    };

    const handleImport = (node: Node) => {
      for (const ch of node.namedChildren.filter(nn)) {
        if (ch.type === 'dotted_name') {
          out.imports.push({ spec: ch.text, bindings: [{ local: ch.text, imported: '*' }], line: node.startPosition.row + 1 });
        } else if (ch.type === 'aliased_import') {
          const nm = ch.childForFieldName('name')!;
          const al = ch.childForFieldName('alias');
          out.imports.push({ spec: nm.text, bindings: [{ local: (al ?? nm).text, imported: '*' }], line: node.startPosition.row + 1 });
        }
      }
    };

    const handleCall = (node: Node, ctx: Ctx) => {
      const fn = node.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier') {
          out.calls.push({ from: ctx.cur, name: fn.text });
          if (fn.text === 'getattr') out.dynamic.push({ from: ctx.cur, name: 'getattr', reason: 'dynamic-dispatch' });
          if (SERVICE_FUNCS.has(fn.text)) out.dynamic.push({ from: ctx.cur, name: fn.text, reason: 'cross-service' });
        } else if (fn.type === 'attribute') {
          const obj = fn.childForFieldName('object');
          const attr = fn.childForFieldName('attribute');
          if (obj && attr) {
            out.calls.push({ from: ctx.cur, name: attr.text, receiver: obj.text.length > 60 ? undefined : obj.text });
            if (EVENT_METHODS.has(attr.text) || attr.text === 'send_signal') out.dynamic.push({ from: ctx.cur, name: attr.text, reason: 'event-bus' });
            else if (ORM_METHODS.has(attr.text) || /\.objects\b/.test(obj.text)) out.dynamic.push({ from: ctx.cur, name: attr.text, reason: 'orm' });
            else if (SERVICE_FUNCS.has(obj.text)) out.dynamic.push({ from: ctx.cur, name: `${obj.text}.${attr.text}`, reason: 'cross-service' });
          }
        }
      }
      walkChildren(node, ctx);
    };

    const walkChildren = (node: Node, ctx: Ctx) => {
      for (const ch of node.namedChildren.filter(nn)) walk(ch, ctx);
    };

    const walk = (node: Node, ctx: Ctx): void => {
      switch (node.type) {
        case 'import_statement':
          handleImport(node);
          return;
        case 'import_from_statement':
          handleImportFrom(node);
          return;
        case 'decorated_definition':
          for (const ch of node.namedChildren.filter(nn)) {
            if (ch.type === 'decorator') {
              if (/inject/i.test(ch.text)) out.dynamic.push({ from: ctx.cur, name: firstLine(ch.text, 40), reason: 'di' });
              walkChildren(ch, ctx);
            } else walk(ch, ctx);
          }
          return;
        case 'function_definition': {
          const nameNode = node.childForFieldName('name');
          if (nameNode && (!ctx.cur || ctx.cls === ctx.cur)) {
            const q = ctx.cls ? `${ctx.cls}.${nameNode.text}` : nameNode.text;
            def('function', nameNode.text, node, nameNode, ctx, q);
            walkChildren(node, { cur: q, cls: ctx.cls });
          } else walkChildren(node, ctx);
          return;
        }
        case 'class_definition': {
          const nameNode = node.childForFieldName('name');
          if (nameNode && (!ctx.cur || ctx.cls === ctx.cur)) {
            const q = ctx.cls ? `${ctx.cls}.${nameNode.text}` : nameNode.text;
            def('class', nameNode.text, node, nameNode, ctx, q);
            const sup = node.childForFieldName('superclasses');
            if (sup) {
              for (const s of sup.namedChildren.filter(nn)) {
                if (s.type === 'identifier' || s.type === 'attribute') out.extends.push({ from: q, name: s.text });
              }
            }
            const body = node.childForFieldName('body');
            if (body) walkChildren(body, { cur: q, cls: q });
          } else walkChildren(node, ctx);
          return;
        }
        case 'assignment': {
          const left = node.childForFieldName('left');
          if (!ctx.cur && !ctx.cls && left && left.type === 'identifier') {
            def('data', left.text, node, left, ctx, left.text);
            const right = node.childForFieldName('right');
            if (right) walk(right, { cur: left.text, cls: '' });
          } else walkChildren(node, ctx);
          return;
        }
        case 'call':
          handleCall(node, ctx);
          return;
        case 'identifier':
          if (ctx.cur) c.ref(ctx.cur, node.text);
          return;
        case 'comment':
          return;
        default:
          walkChildren(node, ctx);
      }
    };

    walk(root, { cur: '', cls: '' });
    return c.finish();
  },
};
