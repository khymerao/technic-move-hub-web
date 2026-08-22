// Macro slots in localStorage, and files on the way in and out.
//
// The origin is shared with the gamepad mapping, so a quota failure here is a
// quota failure there. It is thrown, never swallowed.

export const MACRO_STORE_KEY = 'lego.macros.v1';
const FILE_VERSION = 1;

const newId = () => 'm' + Math.random().toString(36).slice(2, 10);

// An imported macro always lands with unsafe off, whatever the file claims.
const sanitise = (raw) => ({
  id: typeof raw?.id === 'string' && raw.id ? raw.id : newId(),
  name: String(raw?.name ?? 'untitled'),
  source: String(raw?.source ?? ''),
  allowUnsafe: false,
  updatedAt: Number(raw?.updatedAt) || 0,
});

export function createMacroStore(storage) {
  const read = () => {
    try {
      const parsed = JSON.parse(storage.getItem(MACRO_STORE_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };

  const write = (macros) => {
    storage.setItem(MACRO_STORE_KEY, JSON.stringify(macros));
  };

  return {
    list() { return read(); },

    save(macro) {
      const macros = read();
      const saved = {
        id: macro.id || newId(),
        name: String(macro.name ?? 'untitled'),
        source: String(macro.source ?? ''),
        allowUnsafe: macro.allowUnsafe === true,
        updatedAt: macro.updatedAt ?? 0,
      };
      const at = macros.findIndex((m) => m.id === saved.id);
      if (at === -1) macros.push(saved);
      else macros[at] = saved;
      write(macros);
      return saved;
    },

    remove(id) { write(read().filter((m) => m.id !== id)); },

    exportAll() {
      return JSON.stringify({ version: FILE_VERSION, macros: read() }, null, 2);
    },

    // Validated whole, then written whole.
    importFrom(json) {
      let parsed;
      try { parsed = JSON.parse(json); }
      catch { throw new Error('that file could not be read as JSON'); }
      if (parsed?.version !== FILE_VERSION) {
        throw new Error(
          `that file says version ${parsed?.version}; this app reads version ${FILE_VERSION}`);
      }
      if (!Array.isArray(parsed.macros)) {
        throw new Error('that file has no macros array');
      }
      for (const entry of parsed.macros) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw new Error('that file has a non-object entry in its macros array');
        }
      }
      const incoming = parsed.macros.map(sanitise);
      const byId = new Map(read().map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      write([...byId.values()]);
      return incoming;
    },
  };
}
