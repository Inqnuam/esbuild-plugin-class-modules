import { compile } from "sass";
import postcss from "postcss";
import cssModules from "postcss-modules";
import { stat } from "fs/promises";
import path from "path";

import type { AcceptedPlugin } from "postcss";
import type { Options } from "sass";
import type { Plugin } from "esbuild";

const cwd = process.cwd();
const pluginNamespace = "inqnuam-sass-ns"; // to coexist with other plugins

const javascript = /\.(m|c)?js$/;
const importers = /@import (url\(|").*;$/gm;
const fontFaces = /@font-face[^{]*{([^{}]|{[^{}]*})*}/gm;
const inputsFilter = /\.(m|c)?(j|t)sx?$/;

// TODO: add control on more options
// add sourcemaps

export interface IClassModulesConfig {
  filter: RegExp;
  options: {
    sass?: Options<"sync">;
    postcss?: AcceptedPlugin[];
  };
}

const defaultParams: IClassModulesConfig = {
  filter: /(\.modules?)?\.((s)?css|sass)$/i,
  options: {
    sass: {},
    postcss: [],
  },
};

const cssBuilds = new Map();

module.exports = (config = defaultParams): Plugin => {
  let filter = config.filter ?? defaultParams.filter;
  return {
    name: "inqnuam-sass-plugin",
    setup: (build) => {
      build.initialOptions.metafile = true;
      const minify = build.initialOptions.minify;

      build.onEnd(async (endRes) => {
        if (!cssBuilds.size) {
          return;
        }

        const outputs = endRes.metafile?.outputs;

        if (!outputs) {
          return;
        }

        const builders = async (o) => {
          const jsOutputPath = path.resolve(cwd, o);
          const parsedPath = path.parse(jsOutputPath);

          const cssFileName = parsedPath.name + ".css";
          const cssFilePath = `${parsedPath.dir}/${cssFileName}`;

          const { inputs } = outputs[o];

          const importclauses = Object.keys(inputs).filter((x) => inputsFilter.test(x));
          const inputFiles = [];
          importclauses.forEach((x) => {
            inputFiles.push(...endRes.metafile.inputs[x]?.imports.filter((x) => x.path.startsWith(pluginNamespace)).map((x) => x.path));
          });

          const cssFiles = Array.from(new Set(inputFiles))
            .map((x) => cssBuilds.get(x))
            .filter(Boolean);

          if (cssFiles.length) {
            const imports = Array.from(new Set(cssFiles.map((x) => x.imports?.join("\n")).filter(Boolean))).join("\n");
            const fonts = Array.from(new Set(cssFiles.map((x) => x.fonts?.join("\n")).filter(Boolean))).join("\n");
            await build.esbuild.build({
              stdin: {
                contents: cssFiles.map((x) => x.value).join("\n"),
                loader: "css",
              },
              banner: {
                css: `@charset "UTF-8";\n${imports}\n${fonts}`,
              },
              minify: minify,
              outfile: cssFilePath,
            });
          }
        };

        const jsOutputs = Object.keys(outputs).filter((o) => javascript.test(o));

        await Promise.all(jsOutputs.map((o) => builders(o)));
      });

      build.onResolve({ filter: filter, namespace: "file" }, async (args) => {
        const fileDir = path.resolve(args.resolveDir, args.path);

        return {
          path: fileDir,
          namespace: pluginNamespace,
          watchFiles: [fileDir],
        };
      });

      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async (args) => {
        const cachePath = `${pluginNamespace}:${args.path}`;

        let cached = cssBuilds.get(cachePath);

        const lastModifiedTime = (await stat(args.path)).mtimeMs;

        if (lastModifiedTime > cached?.mtimeMs) {
          cssBuilds.delete(cachePath);
          cached = null;
        }

        if (!cached) {
          const result = compile(args.path, { ...config.options.sass, charset: false });

          let jsonContent = "";
          const { css } = await postcss([
            cssModules({
              getJSON(error, json) {
                jsonContent = JSON.stringify(json);
              },
            }),
          ]).process(result.css, {
            from: args.path,
            map: false,
          });

          let cssContent = css;

          const imports = cssContent.match(importers);
          if (imports) {
            cssContent = cssContent.replace(importers, "");
          }

          const fonts = cssContent.match(fontFaces);

          if (fonts) {
            cssContent = cssContent.replace(fontFaces, "");
          }

          cached = {
            mtimeMs: Date.now(),
            value: cssContent,
            json: jsonContent,
            fonts: fonts?.map((f) => f.replace(/\s/g, "")),
            imports,
          };
          cssBuilds.set(cachePath, cached);
        }

        return {
          contents: cached.json,
          loader: "json",
        };
      });
    },
  };
};
