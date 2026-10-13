import type { Node, LanguageParser } from './runtime.js';
import type { FileParse } from '../types.js';
import { nn, SymbolCollector, bodySig, firstLine, pos, EVENT_METHODS, ORM_METHODS, SERVICE_FUNCS } from './util.js';

interface Ctx {
  /** qualified name of the innermost symbol, '' at module scope */
  cur: string;
  cls: string;
  exported: boolean;
}

function unquote(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

export const ecmascript: LanguageParser = {
  id: 'ecmascript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  grammarFor(ext) {
    if (ext === '.tsx') return 'tsx';
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'typescript';
    return 'javascript';
  },
  extract(root: Node, source: string): FileParse {
    const c = new SymbolCollector('typescript', source.split('\n').length);
    const out = c.out;

    const defSymbol = (kind: 'class' | 'function' | 'data', name: string, node: Node, nameNode: Node | null, ctx: Ctx, qname: string, signature?: string) => {
      const p = pos(node);
      c.add({
        qname,
        type: kind,
        name,
        line: p.line,
        endLine: p.endLine,
        col: nameNode ? nameNode.startPosition.column : p.col,
        parent: ctx.cls || undefined,
        exported: ctx.exported,
        sig: bodySig(node.text, name),
        signature: signature ?? firstLine(node.text),
      });
    };

    const handleImport = (node: Node) => {
      const src = node.childForFieldName('source');
      if (!src) return;
      const bindings: { local: string; imported: string }[] = [];
      for (const ch of node.namedChildren.filter(nn)) {
        if (ch.type !== 'import_clause') continue;
        for (const x of ch.namedChildren.filter(nn)) {
          if (x.type === 'identifier') bindings.push({ local: x.text, imported: 'default' });
          else if (x.type === 'namespace_import') {
            const id = x.namedChildren.filter(nn).find((n) => n.type === 'identifier');
            if (id) bindings.push({ local: id.text, imported: '*' });
          } else if (x.type === 'named_imports') {
            for (const s of x.namedChildren.filter(nn)) {
              if (s.type !== 'import_specifier') continue;
              const nm = s.childForFieldName('name')!;
              const al = s.childForFieldName('alias');
              bindings.push({ local: (al ?? nm).text, imported: nm.text });
            }
          }
        }
      }
      out.imports.push({ spec: unquote(src.text), bindings, line: node.startPosition.row + 1 });
    };

    const handleReexport = (node: Node): boolean => {
      const src = node.childForFieldName('source');
      if (!src) return false;
      const bindings: { local: string; imported: string }[] = [];
      let star = false;
      for (const ch of node.children.filter(nn)) {
        if (ch.type === '*') star = true;
        if (ch.type === 'export_clause') {
          for (const s of ch.namedChildren.filter(nn)) {
            if (s.type !== 'export_specifier') continue;
            const nm = s.childForFieldName('name')!;
            const al = s.childForFieldName('alias');
            bindings.push({ local: (al ?? nm).text, imported: nm.text });
          }
        }
      }
      if (star) bindings.push({ local: '*', imported: '*' });
      out.imports.push({ spec: unquote(src.text), bindings, line: node.startPosition.row + 1, reexport: true });
      return true;
    };

    const handleClass = (node: Node, ctx: Ctx) => {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) {
        walkChildren(node, ctx);
        return;
      }
      const name = nameNode.text;
      const qname = ctx.cls ? `${ctx.cls}.${name}` : name;
      defSymbol('class', name, node, nameNode, ctx, qname);
      for (const ch of node.namedChildren.filter(nn)) {
        if (ch.type === 'class_heritage') {
          const ext = ch.namedChildren.filter(nn).find((x) => x.type === 'extends_clause');
          let val: Node | null | undefined = null;
          if (ext) val = ext.childForFieldName('value') ?? ext.namedChildren.filter(nn)[0];
          else if (!ch.namedChildren.filter(nn).some((x) => x.type === 'implements_clause')) val = ch.namedChildren.filter(nn)[0];
          if (val) out.extends.push({ from: qname, name: val.text.replace(/<.*$/s, '') });
        } else if (ch.type === 'decorator' && /Inject|Controller|Component/.test(ch.text)) {
          out.dynamic.push({ from: qname, name: firstLine(ch.text, 40), reason: 'di' });
        }
      }
      const body = node.childForFieldName('body');
      if (!body) return;
      const inner: Ctx = { cur: qname, cls: qname, exported: ctx.exported };
      for (const m of body.namedChildren.filter(nn)) {
        if (m.type === 'method_definition' || m.type === 'public_field_definition' || m.type === 'field_definition') {
          const mn = m.childForFieldName('name');
          if (!mn) continue;
          const val = m.childForFieldName('value');
          const isFn = m.type === 'method_definition' || (val && /function|arrow/.test(val.type));
          const q = `${qname}.${mn.text}`;
          if (isFn) {
            defSymbol('function', mn.text, m, mn, inner, q);
            walkChildren(m, { cur: q, cls: qname, exported: ctx.exported });
          } else walkChildren(m, inner);
        } else walk(m, inner);
      }
    };

    const handleDeclarator = (d: Node, ctx: Ctx) => {
      const nameNode = d.childForFieldName('name');
      const val = d.childForFieldName('value');
      if (!nameNode || nameNode.type !== 'identifier') {
        if (val) walk(val, ctx);
        return;
      }
      const name = nameNode.text;
      if (val && val.type === 'call_expression') {
        const fn = val.childForFieldName('function');
        const arg = val.childForFieldName('arguments')?.namedChildren.filter(nn)[0];
        if (fn?.text === 'require' && arg && arg.type === 'string') {
          out.imports.push({ spec: unquote(arg.text), bindings: [{ local: name, imported: '*' }], line: d.startPosition.row + 1 });
          return;
        }
      }
      if (!ctx.cur && !ctx.cls) {
        if (val && /^(arrow_function|function_expression|function|generator_function)$/.test(val.type)) {
          defSymbol('function', name, d, nameNode, ctx, name);
          walk(val, { cur: name, cls: '', exported: ctx.exported });
        } else if (val && val.type === 'class') {
          walk(val, ctx);
        } else {
          defSymbol('data', name, d, nameNode, ctx, name);
          if (val) walk(val, { cur: name, cls: '', exported: ctx.exported });
        }
      } else if (val) walk(val, ctx);
    };

    const handleCall = (node: Node, ctx: Ctx) => {
      const fn = node.type === 'new_expression' ? node.childForFieldName('constructor') : node.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier') {
          if (fn.text === 'require') {
            const arg = node.childForFieldName('arguments')?.namedChildren.filter(nn)[0];
            if (arg?.type === 'string') out.imports.push({ spec: unquote(arg.text), bindings: [], line: node.startPosition.row + 1 });
          } else {
            out.calls.push({ from: ctx.cur, name: fn.text, isNew: node.type === 'new_expression' });
            if (SERVICE_FUNCS.has(fn.text)) out.dynamic.push({ from: ctx.cur, name: fn.text, reason: 'cross-service' });
          }
        } else if (fn.type === 'member_expression') {
          const obj = fn.childForFieldName('object');
          const prop = fn.childForFieldName('property');
          if (obj && prop) {
            out.calls.push({ from: ctx.cur, name: prop.text, receiver: obj.text.length > 60 ? undefined : obj.text, isNew: node.type === 'new_expression' });
            if (EVENT_METHODS.has(prop.text)) out.dynamic.push({ from: ctx.cur, name: prop.text, reason: 'event-bus' });
            else if (ORM_METHODS.has(prop.text)) out.dynamic.push({ from: ctx.cur, name: prop.text, reason: 'orm' });
            else if (SERVICE_FUNCS.has(obj.text)) out.dynamic.push({ from: ctx.cur, name: `${obj.text}.${prop.text}`, reason: 'cross-service' });
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
        case 'export_statement':
          if (handleReexport(node)) return;
          walkChildren(node, { ...ctx, exported: true });
          return;
        case 'import_statement':
          handleImport(node);
          return;
        case 'function_declaration':
        case 'generator_function_declaration': {
          const nameNode = node.childForFieldName('name');
          if (nameNode && !ctx.cur && !ctx.cls) {
            defSymbol('function', nameNode.text, node, nameNode, ctx, nameNode.text);
            walkChildren(node, { cur: nameNode.text, cls: '', exported: ctx.exported });
          } else walkChildren(node, ctx);
          return;
        }
        case 'class_declaration':
        case 'abstract_class_declaration':
        case 'class':
          if (!ctx.cur || ctx.cls) handleClass(node, ctx);
          else walkChildren(node, ctx);
          return;
        case 'interface_declaration':
        case 'enum_declaration': {
          const nameNode = node.childForFieldName('name');
          if (nameNode && !ctx.cur) {
            defSymbol('class', nameNode.text, node, nameNode, ctx, nameNode.text, `${node.type === 'enum_declaration' ? 'enum' : 'interface'} ${nameNode.text}`);
            const ex = node.namedChildren.filter(nn).find((x) => x.type === 'extends_type_clause');
            if (ex) for (const t of ex.namedChildren.filter(nn)) out.extends.push({ from: nameNode.text, name: t.text.replace(/<.*$/s, '') });
          }
          return;
        }
        case 'lexical_declaration':
        case 'variable_declaration':
          for (const d of node.namedChildren.filter(nn)) if (d.type === 'variable_declarator') handleDeclarator(d, ctx);
          return;
        case 'call_expression':
        case 'new_expression':
          handleCall(node, ctx);
          return;
        case 'decorator':
          if (/Inject/.test(node.text)) out.dynamic.push({ from: ctx.cur, name: firstLine(node.text, 40), reason: 'di' });
          walkChildren(node, ctx);
          return;
        case 'identifier':
        case 'shorthand_property_identifier':
          if (ctx.cur) c.ref(ctx.cur, node.text);
          return;
        case 'type_alias_declaration':
        case 'comment':
          return;
        default:
          walkChildren(node, ctx);
      }
    };

    walk(root, { cur: '', cls: '', exported: false });
    return c.finish();
  },
};
