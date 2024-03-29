## Description

> An esbuild plugin to compile your css stylesheets using [Sass-lang](https://sass-lang.com/documentation/js-api/modules#compile), [PostCSS](https://postcss.org) and [CSS Modules.](https://github.com/css-modules/css-modules)  
> Supports global and local scoped outputs.

# Installation

```bash
yarn add -D esbuild-plugin-class-modules
# or
npm install -D esbuild-plugin-class-modules
```

## Usage

```js
const esbuild = require("esbuild");
const { classModules } = require("esbuild-plugin-class-modules");

esbuild
  .build({
    entryPoints: ["input.js"],
    outdir: "public",
    bundle: true,
    plugins: [classModules()],
  })
  .then((result) => console.log(result))
  .catch(() => process.exit(1));
```

You can also customize Sass compiler, PostCSS and CssModules options.

```js
const cssCompilerOptions = {
  options: {
    sass: {},
    postcss: [],
    cssModules: {

    }
  },
}

// usual esbuild config
{
 ...
 plugins: [classModules(cssCompilerOptions)],
 ...
}

```

By default following file extensions will be considered by the compiler:

    - .css
    - .module.css
    - .modules.css
    - .scss
    - .module.scss
    - .modules.scss
    - .sass

using the regex `/(\.modules?)?\.((s)?css|sass)$/i` .  
To customize this filter passe `filter` regex into plugin options.  
Example to handle only `.scss` files:

```javascript
const cssCompilerOptions = {
  filter: /\.scss$/i,
  options: {
    sass: {},
    postcss: [],
    cssModules: {},
  },
};
```

### Local and Global scops

By default any file ending with `.global.css scss etc.` is considered as global.
To customize this behavior set `globalModulePaths` into plugins `cssModules`.  
Default is `[/\.global\.(s?css|sass)$/]`.  
See [CSS Modules](https://github.com/css-modules/css-modules) for more info.

Another way to declare class names as global scoped is to use nameless import/require.  
Ex:

```javascript
import "./myAwsomeStyles.scss";
```

or as local scoped with named import/require:

```javascript
import style from "./myAwsomeStyles.scss";
```

### Usage with multiple css processor plugins

For better compatibility with other css processors it's prefered to put `esbuild-plugin-class-modules` at after all other css plugins in your esbuild config.

```js
const esbuild = require("esbuild");
const lessCssPlugin = require("some-less-processor-plugin");
const { classModules } = require("esbuild-plugin-class-modules");

esbuild
  .build({
    entryPoints: ["input.js"],
    outdir: "public",
    bundle: true,
    plugins: [lessCssPlugin, classModules()],
  })
  .then((result) => console.log(result))
  .catch(() => process.exit(1));
```
