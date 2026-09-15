// Local typedoc plugin: names the entry-point modules after their package folder
// (`protocol/src` → `protocol`, `react-native/src` → `react-native`) so the
// generated reference lives at /api/reference/<package>/.
import { Converter } from 'typedoc';

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const mod of context.project.children ?? []) {
      mod.name = mod.name.replace(/\/src$/, '');
    }
  });
}
