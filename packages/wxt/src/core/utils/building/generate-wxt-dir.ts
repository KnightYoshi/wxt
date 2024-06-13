import { Unimport, createUnimport } from 'unimport';
import {
  EslintGlobalsPropValue,
  Entrypoint,
  WxtResolvedUnimportOptions,
} from '~/types';
import fs from 'fs-extra';
import { relative, resolve } from 'path';
import {
  getEntrypointBundlePath,
  isHtmlEntrypoint,
} from '~/core/utils/entrypoints';
import { getEntrypointGlobals, getGlobals } from '~/core/utils/globals';
import { normalizePath } from '~/core/utils/paths';
import path from 'node:path';
import { Message, parseI18nMessages } from '~/core/utils/i18n';
import { writeFileIfDifferent, getPublicFiles } from '~/core/utils/fs';
import { wxt } from '../../wxt';

/**
 * Generate and write all the files inside the `InternalConfig.typesDir` directory.
 */
export async function generateTypesDir(
  entrypoints: Entrypoint[],
): Promise<void> {
  await fs.ensureDir(wxt.config.typesDir);

  const references: string[] = [];

  if (wxt.config.imports !== false) {
    const unimport = createUnimport(wxt.config.imports);
    references.push(await writeImportsDeclarationFile(unimport));
    if (wxt.config.imports.eslintrc.enabled) {
      await writeImportsEslintFile(unimport, wxt.config.imports);
    }
  }

  references.push(await writePathsDeclarationFile(entrypoints));
  references.push(await writeI18nDeclarationFile());
  references.push(await writeGlobalsDeclarationFile());

  const mainReference = await writeMainDeclarationFile(references);
  await writeTsConfigFile(mainReference);
}

async function writeImportsDeclarationFile(unimport: Unimport) {
  const filePath = resolve(wxt.config.typesDir, 'imports.d.ts');

  // Load project imports into unimport memory so they are output via generateTypeDeclarations
  await unimport.scanImportsFromDir(undefined, { cwd: wxt.config.srcDir });

  await writeFileIfDifferent(
    filePath,
    ['// Generated by wxt', await unimport.generateTypeDeclarations()].join(
      '\n',
    ) + '\n',
  );

  return filePath;
}

async function writeImportsEslintFile(
  unimport: Unimport,
  options: WxtResolvedUnimportOptions,
) {
  const globals: Record<string, EslintGlobalsPropValue> = {};
  const eslintrc = { globals };

  (await unimport.getImports())
    .map((i) => i.as ?? i.name)
    .filter(Boolean)
    .sort()
    .forEach((name) => {
      eslintrc.globals[name] = options.eslintrc.globalsPropValue;
    });
  await fs.writeJson(options.eslintrc.filePath, eslintrc, { spaces: 2 });
}

async function writePathsDeclarationFile(
  entrypoints: Entrypoint[],
): Promise<string> {
  const filePath = resolve(wxt.config.typesDir, 'paths.d.ts');
  const unions = entrypoints
    .map((entry) =>
      getEntrypointBundlePath(
        entry,
        wxt.config.outDir,
        isHtmlEntrypoint(entry) ? '.html' : '.js',
      ),
    )
    .concat(await getPublicFiles())
    .map(normalizePath)
    .map((path) => `    | "/${path}"`)
    .sort()
    .join('\n');

  const template = `// Generated by wxt
import "wxt/browser";

declare module "wxt/browser" {
  export type PublicPath =
{{ union }}
  type HtmlPublicPath = Extract<PublicPath, \`\${string}.html\`>
  export interface WxtRuntime extends Runtime.Static {
    getURL(path: PublicPath): string;
    getURL(path: \`\${HtmlPublicPath}\${string}\`): string;
  }
}
`;

  await writeFileIfDifferent(
    filePath,
    template.replace('{{ union }}', unions || '    | never'),
  );

  return filePath;
}

async function writeI18nDeclarationFile(): Promise<string> {
  const filePath = resolve(wxt.config.typesDir, 'i18n.d.ts');
  const defaultLocale = wxt.config.manifest.default_locale;
  const template = `// Generated by wxt
import "wxt/browser";

declare module "wxt/browser" {
  /**
   * See https://developer.chrome.com/docs/extensions/reference/i18n/#method-getMessage
   */
  interface GetMessageOptions {
    /**
     * See https://developer.chrome.com/docs/extensions/reference/i18n/#method-getMessage
     */
    escapeLt?: boolean
  }

  export interface WxtI18n extends I18n.Static {
{{ overrides }}
  }
}
`;

  let messages: Message[];
  if (defaultLocale) {
    const defaultLocalePath = path.resolve(
      wxt.config.publicDir,
      '_locales',
      defaultLocale,
      'messages.json',
    );
    const content = JSON.parse(await fs.readFile(defaultLocalePath, 'utf-8'));
    messages = parseI18nMessages(content);
  } else {
    messages = parseI18nMessages({});
  }

  const overrides = messages.map((message) => {
    return `    /**
     * ${message.description || 'No message description.'}
     *
     * "${message.message}"
     */
    getMessage(
      messageName: "${message.name}",
      substitutions?: string | string[],
      options?: GetMessageOptions,
    ): string;`;
  });
  await writeFileIfDifferent(
    filePath,
    template.replace('{{ overrides }}', overrides.join('\n')),
  );

  return filePath;
}

async function writeGlobalsDeclarationFile(): Promise<string> {
  const filePath = resolve(wxt.config.typesDir, 'globals.d.ts');
  const globals = [...getGlobals(wxt.config), ...getEntrypointGlobals('')];
  await writeFileIfDifferent(
    filePath,
    [
      '// Generated by wxt',
      'export {}',
      'interface ImportMetaEnv {',
      ...globals.map((global) => `  readonly ${global.name}: ${global.type};`),
      '}',
      'interface ImportMeta {',
      '  readonly env: ImportMetaEnv',
      '}',
    ].join('\n') + '\n',
  );
  return filePath;
}

async function writeMainDeclarationFile(references: string[]): Promise<string> {
  const dir = wxt.config.wxtDir;
  const filePath = resolve(dir, 'wxt.d.ts');
  await writeFileIfDifferent(
    filePath,
    [
      '// Generated by wxt',
      `/// <reference types="wxt/vite-builder-env" />`,
      ...references.map(
        (ref) =>
          `/// <reference types="./${normalizePath(relative(dir, ref))}" />`,
      ),

      // Add references to modules installed from NPM to the TS project so
      // their type augmentation can update InlineConfig correctly. Local
      // modules defined in <root>/modules are already apart of the project, so
      // we don't need to add them.
      ...wxt.config.modules
        .filter(
          (module) => module.type === 'node_module' && module.configKey != null,
        )
        .map((module) => `/// <reference types="${module.id}" />`),
    ].join('\n') + '\n',
  );
  return filePath;
}

async function writeTsConfigFile(mainReference: string) {
  const dir = wxt.config.wxtDir;
  const getTsconfigPath = (path: string) => normalizePath(relative(dir, path));
  const paths = Object.entries(wxt.config.alias)
    .flatMap(([alias, absolutePath]) => {
      const aliasPath = getTsconfigPath(absolutePath);
      return [
        `      "${alias}": ["${aliasPath}"]`,
        `      "${alias}/*": ["${aliasPath}/*"]`,
      ];
    })
    .join(',\n');

  await writeFileIfDifferent(
    resolve(dir, 'tsconfig.json'),
    `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "strict": true,
    "skipLibCheck": true,
    "paths": {
${paths}
    }
  },
  "include": [
    "${getTsconfigPath(wxt.config.root)}/**/*",
    "./${getTsconfigPath(mainReference)}"
  ],
  "exclude": ["${getTsconfigPath(wxt.config.outBaseDir)}"]
}`,
  );
}
