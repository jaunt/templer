import ejs from "ejs";
import vm from "vm";
import fs from "fs";
import fspath from "path";
import fm from "front-matter";
import pico from "picocolors";
import micromatch from "micromatch";

import {
  getAllFiles,
  isRelative,
  Pinger,
  makeLoggers,
} from "@danglingdev/shared-ts";

const loggers = makeLoggers("@ ");
const log = loggers.log;
const logError = loggers.logError;

export const PRE_GENERATE_JS = "preGenerate.js";
export const POST_GENERATE_JS = "postGenerate.js";
export const PRE_GENERATE_NAME = "PRE_GENERATE";
export const POST_GENERATE_NAME = "POST_GENERATE";

const libDir = "/js";

const SCRIPT_ENTRY = "<script entry>";
const SCRIPT_ENTRY_LENGTH = SCRIPT_ENTRY.length;
const SCRIPT_LIB = "<script lib>";
const SCRIPT_LIB_LENGTH = SCRIPT_LIB.length;
const SCRIPT_GENERATE = "<script generate>";
const SCRIPT_GENERATE_LENGTH = SCRIPT_GENERATE.length;
const SCRIPT_GENERATE_USE = "<script generate-use:";
const SCRIPT_GENERATE_USE_LENGTH = SCRIPT_GENERATE_USE.length;
const SCRIPT_GENERATE_USE_REGEX = /^"([\w-]+(\/([\w-]+))+)">$/;
const END_SCRIPT = "</script>";
const END_SCRIPT_LENGTH = END_SCRIPT.length;
const EXTRACT_SCRIPT = /<script[\s\S]*?>[\s\S]*?<\/script>/gi;

type Code = string;
type PageName = string;
type TemplateName = string;
type Path = string;

type Script = {
  [key: PageName]: Code;
};

type ScriptRef = {
  [key: PageName]: string;
};

export type Dependencies = {
  [key: PageName]: boolean;
};

type DependencyTree = {
  [key: string]: Dependencies;
};

type FrontMatterEntries = {
  [key: string]: unknown;
};

type FrontMatter = {
  [key: PageName]: FrontMatterEntries;
};

type CompiledTemplate = {
  [key: PageName]: ejs.ClientFunction;
};

export enum TriggerReason {
  Added,
  Modified,
  Deleted,
}

type ToGenerateData = {
  name: PageName;
  generate: string;
  triggeredBy: string;
  reason: TriggerReason;
};

type ToGenerate = {
  [key: string]: ToGenerateData;
};

type PageData = {
  [key: string]: unknown;
};

type CacheItem = {
  expires: number;
  data: PageData;
};

type CacheData = {
  [key: string]: CacheItem;
};

type Cache = {
  [key: PageName]: CacheData;
};

type GeneratorDataOutput = {
  [key: PageName]: { [key: string]: PageData };
};

type FilesWritten = {
  source: string;
  path: string;
  time: string;
};

type OutputData = {
  html: FilesWritten[];
  entry: FilesWritten[];
  lib: FilesWritten[];
  json: FilesWritten[];
  outData: GeneratorDataOutput;
};

type PageGenerateRequest = {
  path: string;
  data: PageData;
};

type GeneratorPages = PageGenerateRequest[] | PageGenerateRequest;

type GeneratorResponse = {
  cache: CacheData;
  siteFiles: { [key: Path]: unknown };
  watchFiles: Path[];
  watchGlobs: string[];
  outData: GeneratorDataOutput;
  global: PageData; // only valid from pregenerat
};

type TemplerData = {
  generateScripts: Script;
  generateScriptRefs: ScriptRef;
  entryScripts: Script;
  templateDepTree: DependencyTree;
  pathDepTree: DependencyTree;
  wildDepTree: DependencyTree;
  globalDeps: Dependencies;
  frontMatter: FrontMatter;
  templates: CompiledTemplate;
  toGenerate: ToGenerate;
  globalData: PageData;
  cache: Cache;
  outputData: OutputData;
  errorCount: 0;
};

type fsFunc = (...args: any[]) => unknown;

function getNowDate(): string {
  const d = new Date();
  return d.toISOString();
}

function safeOutputCheck(
  func: fsFunc,
  outPath: string,
  path: string,
  ...args: unknown[]
) {
  if (!isRelative(outPath, path)) {
    throw new Error(
      "Trying to write " + path + " which is outside of " + outPath
    );
  }
  func(path, ...args);
}

function stringifyFuncs(_: any, v: any) {
  if (typeof v === "function") {
    return "render function";
  }
  return v;
}

export class Templer {
  readonly inputDir: string;
  readonly dataDir: string;
  readonly outputDir: string;
  readonly cacheDir: string;
  readonly outPath: string;
  readonly verbose: string;

  constructor(
    inputDir: string,
    dataDir: string,
    outputDir: string,
    cacheDir: string,
    verbose: string
  ) {
    this.inputDir = inputDir;
    this.dataDir = dataDir;
    this.outputDir = outputDir;
    this.cacheDir = cacheDir;
    this.outPath = fspath.resolve("./" + this.outputDir);
    this.verbose = verbose;
    this.loadCache();
  }

  private state: TemplerData = {
    generateScripts: {},
    generateScriptRefs: {},
    entryScripts: {},
    templateDepTree: {},
    pathDepTree: {},
    wildDepTree: {},
    globalDeps: {},
    frontMatter: {},
    templates: {},
    toGenerate: {},
    globalData: {},
    cache: {},
    outputData: {
      html: [],
      entry: [],
      lib: [],
      json: [],
      outData: {},
    },
    errorCount: 0,
  };

  getErrorCount() {
    return this.state.errorCount;
  }

  protected writeFileSafe(path: string, ...args: unknown[]) {
    safeOutputCheck(fs.writeFile, this.outputDir, path, ...args);
  }

  protected mkdirSyncSafe(path: string, ...args: unknown[]) {
    safeOutputCheck(fs.mkdirSync, this.outputDir, path, ...args);
  }

  /// ----------------------------------------------------------------------------
  /// Safety to prevent user from accidently
  /// writing files outside the output directory
  /// ----------------------------------------------------------------------------
  protected getDataFileNames(
    source: string,
    globList?: string | string[]
  ): string[] {
    const resData = fspath.resolve(this.dataDir);
    let files = getAllFiles(resData);

    if (globList) {
      let fixedGlobs: string[];
      if (!Array.isArray(globList)) {
        fixedGlobs = [globList];
      } else {
        fixedGlobs = globList;
      }
      fixedGlobs = fixedGlobs.map((glob) => {
        return resData + "/" + glob;
      });
      files = micromatch(files, fixedGlobs);
    }
    if (files.length == 0) {
      logError(
        pico.red(
          "Warning, " +
            source +
            ".ejs requested data files but none were found at " +
            this.dataDir
        )
      );
    }
    return files;
  }

  public getTemplateFileName(file: Path): string {
    const p = fspath.join("./", this.inputDir, "/", file);
    return p;
  }

  /// -----------------------------------------------------------------------------
  /// Caching
  /// -----------------------------------------------------------------------------
  protected expireCache(): void {
    for (const cacheName in this.state.cache) {
      const cacheGroup = this.state.cache[cacheName];
      for (const itemName in cacheGroup) {
        const expires = cacheGroup[itemName].expires;
        if (expires) {
          if (!isNaN(expires)) {
            const now = new Date().getTime();
            if (now > expires) {
              log(
                pico.green("Expired " + cacheName + " cache item: " + itemName)
              );
              delete cacheGroup[itemName];
            }
          } else {
            throw new Error(
              cacheName + " cache item " + itemName + " expires date is invalid"
            );
          }
        }
      }
    }
  }
  protected loadCache(): void {
    const p = fspath.resolve(this.cacheDir);
    if (fs.existsSync(p + "/cache.json")) {
      let rawdata = fs.readFileSync(p + "/cache.json");
      if (rawdata && rawdata.length > 0) {
        this.state.cache = JSON.parse(rawdata.toString());
      }
    }
  }

  // call before exiting
  public storeCache(): void {
    const p = fspath.resolve(this.cacheDir);
    let data = JSON.stringify(this.state.cache);
    if (data) {
      if (!fs.existsSync(this.cacheDir)) {
        log(pico.green("Making cache dir: " + p));
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      log(pico.green("Writing cache: " + p + "/cache.json"));
      fs.writeFileSync(this.cacheDir + "/cache.json", data);
    }
  }

  /// -----------------------------------------------------------------------------
  /// Helpers
  /// -----------------------------------------------------------------------------
  protected getGlobalDataAccessProxy(name: PageName): typeof Proxy {
    // a proxy to detect access to global data from scripts
    const state = this.state;
    const globalDataAccessHandler = {
      get: function (...args: any) {
        // access to global deps was detected
        if (!state.globalData[args[1] as string]) {
          throw new Error(
            "Accessing undefined global data Element: " + args[1]
          );
        }
        state.globalDeps[name] = true;
        return Reflect.get.apply(null, args);
      },
    };
    return new Proxy(state.globalData, globalDataAccessHandler);
  }

  protected chalkUpError(name: PageName, error: Error): void {
    // Show generate script errors nicely.
    logError("\nScript Error: " + pico.bgBlack(pico.red(name)));
    if (error.message) {
      log(pico.bgBlack(pico.white(error.message)));
    }
    if (typeof error == "string") {
      log(pico.bgBlack(pico.white(error)));
    }
    if (error.stack) {
      try {
        const lines = error.stack.split("\n");
        const errorLine = Number(lines[0].split(":")[1]) - 1;
        const script = this.getGenerateScript(name).split("\n");
        script.forEach((line, index) => {
          if (index == errorLine) {
            log(pico.bgBlack(pico.red(line)));
          } else {
            log(pico.bgBlack(pico.blue(line)));
          }
        });
      } catch {
        this.state.errorCount++;
        log(pico.red(error.stack));
      }
    }
  }

  protected scriptLogger(name: PageName): void {
    // Format log messages from generate script.
    const args = Array.from(arguments);
    log(pico.yellow(name) + pico.white(": " + args[1]), ...args.slice(2));
  }

  protected fixPath(path: string): string {
    // trim trailing path if it exists.
    // this should allow us to work no matter how
    // the user specified generate paths
    if (path.length && path.slice(-1) == "/") {
      path = path.substring(0, path.length - 1);
      return path;
    }
    return path;
  }

  protected markDependsOn(template: string, dependency: string) {
    if (!this.state.templateDepTree[dependency]) {
      this.state.templateDepTree[dependency] = {};
    }
    this.state.templateDepTree[dependency][template] = true;
  }

  protected writeEntryScript(
    template: string,
    script: string,
    path: string,
    name: string
  ): void {
    const writePath = "./" + fspath.join(this.outputDir, "/", path);
    if (!fs.existsSync(writePath)) {
      this.mkdirSyncSafe(writePath, { recursive: true });
    }
    const p = fspath.resolve(writePath + "/" + name);
    this.state.outputData.entry.push({
      source: template,
      path: p,
      time: getNowDate(),
    });
    this.writeFileSafe(p, script, (err: NodeJS.ErrnoException | null): void => {
      if (err) {
        this.state.errorCount++;
        logError(pico.red("Error writting: " + p));
      } else {
        log(pico.magenta("Wrote: " + p));
      }
    });
  }

  protected processEntryScripts(pageName: string, outPath: string) {
    // Write out entry scripts (and append wrapper entry scripts)
    const me = this;
    let entryScripts: string[] = [];
    if (me.state.entryScripts[pageName] != undefined) {
      if (me.verbose) {
        log(pico.yellow("using entry script for '" + pageName + "'"));
      }
      entryScripts.unshift(
        "// entry script: " + pageName + "\n" + me.state.entryScripts[pageName]
      );
    }
    // find any wrapper entry scripts
    let wrapperRef = pageName;
    while (wrapperRef) {
      const wrapperPage = me.state.frontMatter[wrapperRef].wrapper as string;
      if (wrapperPage) {
        if (me.state.entryScripts[wrapperPage] != undefined) {
          if (me.verbose) {
            log(
              pico.yellow(
                "appending wrapper entry script from '" +
                  wrapperPage +
                  "' for '" +
                  pageName +
                  "'"
              )
            );
          }
          entryScripts.unshift(
            "// entry script: " +
              wrapperPage +
              "\n" +
              me.state.entryScripts[wrapperPage]
          );
        }
      }
      wrapperRef = wrapperPage;
    }
    if (entryScripts.length) {
      const script = entryScripts.join("\n");
      const scriptName = me.getEntryScriptName(outPath);
      me.writeEntryScript(pageName, script, outPath, scriptName + ".js");
    }
  }

  /// -----------------------------------------------------------------------------
  /// processGeneratorResponse
  ///
  /// Process what was resolved from generator scripts.
  /// Deal with returned promise such as cache, site data, and dependency requests
  /// -----------------------------------------------------------------------------
  protected processGeneratorResponse(
    response: GeneratorResponse | undefined,
    name: PageName,
    cacheName: string
  ): void {
    if (!response) {
      return;
    }
    if (response.cache) {
      // page is requesting to update its cache
      this.state.cache[cacheName] = response.cache;
    }
    if (response.outData) {
      this.state.outputData.outData[name] = response.outData;
    }
    if (response.siteFiles) {
      // page is asking to create a json file in the output directory
      const siteFiles = response.siteFiles;

      for (const file in siteFiles) {
        const p = fspath.resolve(
          "./" + fspath.join(this.outputDir + "/" + file)
        );
        const writePath = fspath.parse(p).dir;
        if (!fs.existsSync(writePath)) {
          this.mkdirSyncSafe(writePath, { recursive: true });
        }
        this.state.outputData.json.push({
          source: name,
          path: p,
          time: getNowDate(),
        });
        let writeData;
        if (
          typeof siteFiles[file] === "string" ||
          siteFiles[file] instanceof String
        ) {
          writeData = siteFiles[file];
        } else {
          writeData = JSON.stringify(siteFiles[file]);
        }
        this.writeFileSafe(
          p,
          writeData,
          (err: NodeJS.ErrnoException | null): void => {
            if (err) {
              this.state.errorCount++;
              logError(
                pico.red(
                  "Error writing template's siteFiles '" + name + "': '" + p
                )
              );
            } else {
              log(pico.cyan("Wrote: " + p));
            }
          }
        );
      }
    }
    if (response.watchFiles) {
      response.watchFiles.forEach((file: Path) => {
        const dep = fspath.resolve(file);
        if (!this.state.pathDepTree[dep]) {
          this.state.pathDepTree[dep] = {};
        }
        this.state.pathDepTree[dep][name] = true;
      });
    }
    if (response.watchGlobs) {
      response.watchGlobs.forEach((glob: string) => {
        if (!this.state.wildDepTree[glob]) {
          this.state.wildDepTree[glob] = {};
        }
        this.state.wildDepTree[glob][name] = true;
      });
    }
  }

  /// -----------------------------------------------------------------------------
  /// getEntryScriptName
  ///
  /// Get the entry script name for a template
  /// -----------------------------------------------------------------------------
  protected getEntryScriptName(path: string): string {
    const parts = path.split("/");
    let scriptName = "";
    if (path == "") {
      scriptName = "main";
    } else if (parts.length) {
      scriptName = parts[parts.length - 1];
    } else {
      scriptName = "main";
    }
    return scriptName;
  }

  /// -----------------------------------------------------------------------------
  /// renderRecursive
  /// Render a template and its children recursively
  /// -----------------------------------------------------------------------------
  protected renderRecursive(
    parent: TemplateName, // orginal template name
    wrapStack: string[], // stack of wrappers
    passedData: PageData, // from front matter, global, etc
    progress: string[], // last template worked on in recursion by ref
    current: TemplateName, // included template
    includeData?: PageData // passed with ejs include
  ): string {
    progress[0] = current;
    // Check for _body include
    if (current == "_body") {
      if (wrapStack.length == 0) {
        throw new Error("Wrapper " + parent + " was not wrapping anything");
      }
      current = wrapStack.pop() as string;
    } else {
      // template depends on this dependency
      this.markDependsOn(parent, current);
      // Wrappers render where _body gets redirected back to wrapped template.
      // Support nested wrapping.
      let wrapper = current;
      let wrapCheck = wrapper;
      wrapStack = [];
      while (this.state.frontMatter[wrapCheck]?.wrapper) {
        wrapper = this.state.frontMatter[wrapCheck].wrapper as string;
        // current depends on this wrapper
        this.markDependsOn(current, wrapper);
        wrapStack.push(wrapCheck);
        wrapCheck = wrapper;
      }
      current = wrapper;
    }
    // combine data from passed, current front matter, and passed with include
    const renderData = {
      ...passedData,
      ...(this.state.frontMatter[current] || {}),
      ...(includeData || {}),
    };

    return this.state.templates[current](
      renderData,
      undefined,
      this.renderRecursive.bind(this, parent, wrapStack, renderData, progress)
    );
  }

  /// -----------------------------------------------------------------------------
  /// renderTemplate
  ///
  /// recursively render a template and all its children / wrappers to disk
  /// -----------------------------------------------------------------------------
  protected renderTemplate(
    template: TemplateName,
    path: string,
    data: PageData
  ) {
    let _progress = [template];
    const me = this;

    try {
      path = me.fixPath(path);

      const entryScriptName = me.getEntryScriptName(path);

      const inputVars = {
        pagePath: path,
        pageName: template,
        lastPath: entryScriptName,
        entryScript: (path == "/" ? "" : path + "/") + entryScriptName + ".js",
      };

      const renderData = {
        ...inputVars,
        ...data,
      };

      const html = me.renderRecursive(
        template,
        [],
        renderData,
        _progress,
        template
      );

      const writePath = "./" + fspath.join(me.outputDir, "/", path);
      if (!fs.existsSync(writePath)) {
        me.mkdirSyncSafe(writePath, { recursive: true });
      }
      const p = fspath.resolve(writePath + "/index.html");
      me.state.outputData.html.push({
        source: template,
        path: p,
        time: getNowDate(),
      });
      me.writeFileSafe(p, html, (err: NodeJS.ErrnoException | null): void => {
        if (err) {
          throw err;
        } else {
          log(pico.magenta("Wrote: " + p));
        }
      });
      return path;
    } catch (error) {
      me.state.errorCount++;
      logError(
        pico.red(
          pico.bold(
            `Error rendering page: ${template}, template: ${_progress[0]}, path: ${path}`
          )
        )
      );
      logError(error);
      throw error;
    }
  }

  /// -----------------------------------------------------------------------------
  /// generatePages
  ///
  /// Generate all cued pages
  /// running generate scripts if specified,
  /// rendering templates to disk.
  /// -----------------------------------------------------------------------------
  public generatePages(): Promise<void> {
    const me = this;
    return new Promise(function (resolve, _) {
      let toGenerate = Object.values(me.state.toGenerate);
      let toRender = toGenerate.length; // todo list count

      const checkDone = (
        pageName: PageName,
        generated: Boolean = false,
        outPath: string = ""
      ) => {
        // if a page was generated, process any entry scripts
        if (generated) {
          me.processEntryScripts(pageName, outPath);
        }
        // else subtract from todo list
        toRender--;
        if (toRender == 0) {
          resolve();
        }
      };

      if (toRender == 0) {
        log(pico.yellow("\nNothing to do.  Will wait for changes."));
        resolve();
        return;
      }

      const generateSimple = (pageName: string, path: string) => {
        // Generate a page that does not have a generate script
        // or returns no page creation data from it
        const data = {
          global: me.getGlobalDataAccessProxy(pageName),
          ...me.state.frontMatter[pageName],
        };
        try {
          const fixedPath = me.renderTemplate(pageName, path, data);
          checkDone(pageName, true, fixedPath);
        } catch (error) {
          checkDone(pageName);
        }
      };

      toGenerate.forEach((generateData: ToGenerateData) => {
        delete me.state.toGenerate[generateData.name]; // mark completed
        if (me.getGenerateScript(generateData.name)) {
          let rendered = 0;
          let pinger = new Pinger(
            generateData.name,
            (id: string) => {
              log(pico.yellow("Waiting for generator to call resolve: " + id));
            },
            3000
          );
          const generateDone = (response: GeneratorResponse) => {
            pinger.stop();
            log(pico.yellow("Generator Resolved: " + generateData.name));

            if (rendered == 0) {
              const pathStars = (generateData.generate.match(/\*/g) || [])
                .length;
              if (pathStars > 0) {
                if (me.verbose) {
                  log(
                    pico.yellow(
                      "Generate script '" +
                        generateData.name +
                        "' requested no pages.  Ignoring."
                    )
                  );
                }
              } else {
                if (me.verbose) {
                  log(
                    pico.yellow(
                      "Rendering template " +
                        generateData.name +
                        " with absolute generate path after running its generate script."
                    )
                  );
                }

                toRender++; // need to generate just one page
                generateSimple(generateData.name, generateData.generate);
              }
            }

            // callback on generate script complete
            me.processGeneratorResponse(
              response,
              generateData.name,
              me.getCacheName(generateData.name)
            );
            checkDone(generateData.name);
          };

          const generatePages = (response: GeneratorPages) => {
            log(
              pico.yellow("Generating batch pages for: " + generateData.name)
            );
            let pages: PageGenerateRequest[];
            if (!Array.isArray(response)) {
              // script specified a single page to generate
              pages = [response as PageGenerateRequest];
            } else {
              // script specified an array of pages to generate
              pages = response as PageGenerateRequest[];
            }
            const pathStars = (generateData.generate.match(/\*/g) || []).length;
            if (pathStars > 1) {
              throw new Error(
                "Generate paths can only include a single path replacement *" +
                  generateData.name
              );
            } else if (pathStars == 0) {
              throw new Error(
                "Generate paths must include a path replacement * when generating 1 or more pages from data." +
                  generateData.name
              );
            } else {
              if (pages.length == 0) {
                if (me.verbose) {
                  log(
                    pico.yellow(
                      "Generate script " +
                        generateData.name +
                        " requesting zero pages to render"
                    )
                  );
                }
              } else {
                toRender += pages.length; // add extra pages to todo list
                pages.forEach((generatePageRequest: PageGenerateRequest) => {
                  const data = {
                    global: me.getGlobalDataAccessProxy(generateData.name),
                    ...generatePageRequest.data,
                    ...me.state.frontMatter[generateData.name],
                  };
                  const starReplacedPath = generateData.generate.replace(
                    /\*/,
                    generatePageRequest.path
                  );
                  rendered++;
                  try {
                    const fixedPath = me.renderTemplate(
                      generateData.name,
                      starReplacedPath,
                      data
                    );
                    checkDone(generateData.name, true, fixedPath);
                  } catch (error) {
                    checkDone(generateData.name);
                  }
                });
              }
            }
          };
          const generateError = (error: Error) => {
            pinger.stop();
            me.chalkUpError(generateData.name, error);
            checkDone(generateData.name);
          };
          if (!me.state.cache[me.getCacheName(generateData.name)]) {
            me.state.cache[me.getCacheName(generateData.name)] = {};
          }

          let reason = "";
          if (generateData.triggeredBy) {
            switch (generateData.reason) {
              case TriggerReason.Added:
                reason = "Added";
                break;
              case TriggerReason.Modified:
                reason = "Modified";
                break;
              case TriggerReason.Deleted:
                reason = "Deleted";
                break;
            }
          }

          const inputs = {
            triggeredBy: generateData.triggeredBy
              ? {
                  path: generateData.triggeredBy,
                  reason: reason,
                }
              : undefined,
            frontMatter: me.state.frontMatter[generateData.name],
            global: me.getGlobalDataAccessProxy(generateData.name),
          };

          // in case a generate script wants to directly render a template
          const _progress = [""];
          const renderTemplate = (template: string, data: PageData) => {
            _progress[0] = template;
            try {
              const html = me.renderRecursive(
                generateData.name,
                [],
                data,
                _progress,
                template
              );
              return html;
            } catch (error) {
              throw new Error(
                "Couldn't render template " +
                  template +
                  " (" +
                  _progress[0] +
                  "): " +
                  error
              );
            }
          };

          const code =
            "((require, resolve, reject, generate, inputs, getDataFileNames, cache, log, frontMatterParse, dataDir, renderTemplate) =>  {" +
            me.getGenerateScript(generateData.name) +
            "})";
          me.expireCache();
          try {
            vm.runInThisContext(code)(
              require,
              generateDone, // set done
              generateError,
              generatePages, // render array of pages and continue
              inputs,
              me.getDataFileNames.bind(me, generateData.name),
              me.state.cache[me.getCacheName(generateData.name)],
              me.scriptLogger.bind(null, generateData.name),
              fm,
              fspath.resolve(me.dataDir),
              renderTemplate
            );
          } catch (error: unknown) {
            me.state.errorCount++;
            if (error instanceof Error) {
              generateError(error);
            } else {
              logError(pico.red("Unknown error " + error));
              generateError(new Error("unknown error"));
            }
          }
        } else if (generateData.generate) {
          generateSimple(generateData.name, generateData.generate);
        }
      });
    });
  }

  /// -----------------------------------------------------------------------------
  /// compileTemplate
  ///
  /// Pre-compile an EJS template
  /// -----------------------------------------------------------------------------
  protected compileTemplate(source: string, name: TemplateName): void {
    // Pre compile ejs template
    try {
      const fn = ejs.compile(source, { client: true });
      this.state.templates[name] = fn;
    } catch (error) {
      this.state.errorCount++;
      logError(
        pico.red(`${(error as Error).message?.split("\n")[0]} in ${name}`)
      );
    }
  }

  /// -----------------------------------------------------------------------------
  /// cueGeneration
  ///
  /// Mark a page to be generated
  /// -----------------------------------------------------------------------------
  protected cueGeneration(
    name: PageName,
    triggeredBy = "",
    reason = TriggerReason.Modified
  ): void {
    const generate = this.state.frontMatter[name].generate as string;
    if (generate) {
      this.state.toGenerate[name] = {
        name: name,
        generate: generate,
        triggeredBy: triggeredBy,
        reason: reason,
      };
    }
  }

  /// -----------------------------------------------------------------------------
  /// getGenerateScript
  ///
  /// Get cache name -- all scripts referring to another script share it's cache
  /// -----------------------------------------------------------------------------
  protected getCacheName(name: PageName): string {
    return "shared";
    // ... much more convenient if all pages share the same cache
    // even though it forces "reusable generate scripts" to uniquely name their cache keys
    /*
    if (this.state.generateScripts[name]) {
      return "_" + name;
    }
    const ref = this.state.generateScriptRefs[name];
    if (ref) {
      if (this.state.generateScripts[ref]) {
        if (this.verbose) {
          log(
            pico.yellow(
              "using reference cache '" + ref + "' for '" + name + "'"
            )
          );
        }
        return "_" + ref;
      }
    }
    logError("Unexpected attempt to get cache for non script: " + name);
    return "_ERROR";
    */
  }

  /// -----------------------------------------------------------------------------
  /// getGenerateScript
  ///
  /// Get script for template, either direct or referred
  /// -----------------------------------------------------------------------------
  protected getGenerateScript(name: PageName): string {
    if (this.state.generateScripts[name]) {
      return this.state.generateScripts[name];
    }
    const ref = this.state.generateScriptRefs[name];
    if (ref) {
      if (this.state.generateScripts[ref]) {
        if (this.verbose) {
          log(
            pico.yellow(
              "using reference generate script '" + ref + "' for '" + name + "'"
            )
          );
        }
        return this.state.generateScripts[ref];
      }
    }
    return "";
  }

  /// -----------------------------------------------------------------------------
  /// processScript
  ///
  /// Process a script tag found in a template file.
  /// - Generate scripts are stored,
  /// - site scripts are state to output.
  /// -----------------------------------------------------------------------------
  protected processScript(source: string, name: PageName): boolean {
    if (source.startsWith(SCRIPT_GENERATE)) {
      // add generate source to build map
      const stripped = source.slice(SCRIPT_GENERATE_LENGTH, -END_SCRIPT_LENGTH);
      this.state.generateScripts[name] = stripped;
      return true;
    }
    if (source.startsWith(SCRIPT_GENERATE_USE)) {
      // refer to an existing script
      const stripped = source
        .slice(SCRIPT_GENERATE_USE_LENGTH, -END_SCRIPT_LENGTH)
        .trim();

      const match = stripped.match(SCRIPT_GENERATE_USE_REGEX);

      if (match) {
        const dependency = match[1];
        this.state.generateScriptRefs[name] = dependency;
        // add source of generate script as a dependency
        this.markDependsOn(name, dependency);
      } else {
        logError(
          pico.red(
            "Generate-use script template in: '" +
              name +
              "' not specified correctly.  See: (https://jaunt.github.io/templer/docs/input/templates)"
          )
        );
      }

      return true;
    }

    if (source.startsWith(SCRIPT_ENTRY)) {
      // add entry source to build map
      const stripped = source.slice(SCRIPT_ENTRY_LENGTH, -END_SCRIPT_LENGTH);
      this.state.entryScripts[name] = stripped;
      return true;
    } else if (source.startsWith(SCRIPT_LIB)) {
      // create <file>.js for any component source in output/js
      const stripped = source.slice(SCRIPT_LIB_LENGTH, -END_SCRIPT_LENGTH);
      const parsed = fspath.parse(name);
      const dir = parsed.dir;
      if (!fs.existsSync(this.outputDir + libDir + "/" + dir)) {
        this.mkdirSyncSafe(this.outputDir + libDir + "/" + dir, {
          recursive: true,
        });
      }
      const p = fspath.resolve(this.outputDir + libDir + "/" + name + ".js");
      this.state.outputData.lib.push({
        source: name,
        path: p,
        time: getNowDate(),
      });
      this.writeFileSafe(
        p,
        stripped,
        (err: NodeJS.ErrnoException | null): void => {
          if (err) {
            this.state.errorCount++;
            logError(err);
          }
          log(pico.cyan("Wrote: " + p));
        }
      );
      return true;
    }
    return false;
  }

  /// -----------------------------------------------------------------------------
  /// testTemplate
  ///
  /// Make sure extension is ejs and format the name the way we like it.
  /// -----------------------------------------------------------------------------
  protected testTemplate(file: Path): string | undefined {
    const parsed = fspath.parse(file);
    const rel = fspath.relative(this.inputDir, parsed.dir);
    const name = rel + (rel ? "/" : "") + parsed.name;
    const ext = fspath.parse(file).ext;
    if (ext == ".ejs") {
      return name;
    }
    return undefined;
  }

  /// -----------------------------------------------------------------------------
  /// processDeletedTemplatePromise
  ///
  /// Remove template from site data
  /// -----------------------------------------------------------------------------
  public processDeletedTemplatePromise(template: string): void {
    // clean up template state
    delete this.state.generateScripts[template];
    delete this.state.generateScriptRefs[template];
    delete this.state.entryScripts[template];
    for (let key in this.state.pathDepTree) {
      delete this.state.pathDepTree[key][template];
    }
    for (let key in this.state.wildDepTree) {
      delete this.state.wildDepTree[key][template];
    }
    delete this.state.globalDeps[template];
    delete this.state.frontMatter[template];
    delete this.state.toGenerate[template];
    delete this.state.cache[this.getCacheName(template)];
    delete this.state.outputData.outData[template];
  }

  /// -----------------------------------------------------------------------------
  /// processTemplateFilesPromise
  ///
  /// Process all template files found under input directory,
  /// or a single file if we had been watching it for changes.
  /// -----------------------------------------------------------------------------
  public processTemplateFilesPromise(
    file: string | undefined = undefined
  ): Promise<string[]> {
    const me = this;
    return new Promise(function (resolve, reject) {
      let list: string[] = [];
      if (file == undefined) {
        try {
          list = getAllFiles(me.inputDir);
        } catch (error) {
          me.state.errorCount++;
          logError(pico.red("Could not scan " + me.inputDir));
        }
      } else {
        list = [file];
      }

      const names: string[] = [];

      let pending = list.length;
      const checkDone = (name?: string) => {
        if (name) {
          names.push(name);
        }
        pending--;
        if (pending <= 0) {
          resolve(names);
        }
      };

      if (list.length == 0) {
        resolve([]);
        return;
      }

      log(pico.green(`Processing ${pending} input files.`));

      list.forEach((file: Path) => {
        const name = me.testTemplate(file);
        if (name) {
          fs.readFile(file, "utf8", function (err, data) {
            if (err) reject(err);
            const content = fm(data);
            me.state.frontMatter[name] =
              content.attributes as FrontMatterEntries;
            const body = content.body;
            const remove: [number, number][] = [];
            const replacer = (match: string, offset: number) => {
              const used = me.processScript(match, name);
              if (used) {
                const first = offset;
                const second = offset + match.length;
                remove.push([first, second]);
              }
              return "";
            };
            body.replace(EXTRACT_SCRIPT, replacer);
            // piece together template without scripts
            let template = "";
            let index = 0;
            if (remove.length > 0) {
              remove.forEach((script) => {
                template += body.substr(index, script[0] - index);
                index = script[1];
              });
            } else template = body;
            log("compiling template: " + name);
            me.compileTemplate(template.trim(), name);
            me.cueGeneration(name);
            checkDone(name);
          });
        } else {
          checkDone();
        }
      });
    });
  }

  /// -----------------------------------------------------------------------------
  /// processPreGenerate
  ///
  /// preGenerate.js creates global data for all generate scripts.
  /// If changed via watcher, make sure to re-generate
  /// any pages that asked to depend on global.
  /// -----------------------------------------------------------------------------
  public processPreGenerate(): Promise<void> {
    const me = this;
    return new Promise(function (resolve, reject) {
      const g = me.inputDir + "/" + PRE_GENERATE_JS;
      if (fs.existsSync(g)) {
        let pinger = new Pinger(
          "preGenerate",
          (id: string) => {
            log(pico.yellow("Waiting for generator to call resolve: " + id));
          },
          3000
        );
        const generateSuccess = (response: GeneratorResponse) => {
          pinger.stop();
          me.state.globalData = response.global;
          me.processGeneratorResponse(
            response,
            PRE_GENERATE_JS,
            me.getCacheName(PRE_GENERATE_NAME)
          );
          resolve();
        };

        const generateError = (error: Error) => {
          pinger.stop();
          me.chalkUpError(PRE_GENERATE_NAME, error);
          reject(error);
        };
        const script = fs.readFileSync(g, "utf8");
        if (!me.state.cache[me.getCacheName(PRE_GENERATE_NAME)]) {
          me.state.cache[me.getCacheName(PRE_GENERATE_NAME)] = {};
        }
        const code =
          "((require, resolve, reject, cache, log, dataDir) =>  {" +
          script +
          "})";
        try {
          vm.runInThisContext(code)(
            require,
            generateSuccess,
            generateError,
            me.state.cache[me.getCacheName(PRE_GENERATE_NAME)],
            me.scriptLogger.bind(null, PRE_GENERATE_NAME),
            fspath.resolve(me.dataDir)
          );
        } catch (error) {
          me.state.errorCount++;
          logError(error);
          reject(error);
        }
      } else {
        log(pico.blue(PRE_GENERATE_JS + " not found, skipping."));
        resolve(); // no global data
      }
    });
  }

  /// -----------------------------------------------------------------------------
  /// processPostGenerate
  ///
  /// postGenerate.js has access what we wrote during site generation
  /// -----------------------------------------------------------------------------
  public processPostGenerate(): Promise<void> {
    const me = this;
    return new Promise(function (resolve, reject) {
      const g = me.inputDir + "/" + POST_GENERATE_JS;
      if (fs.existsSync(g)) {
        let pinger = new Pinger(
          "postGenerate",
          (id: string) => {
            log(pico.yellow("Waiting for generator to call resolve: " + id));
          },
          3000
        );
        const generateSuccess = (response: GeneratorResponse) => {
          pinger.stop();
          me.processGeneratorResponse(
            response,
            POST_GENERATE_JS,
            me.getCacheName(POST_GENERATE_NAME)
          );
          resolve();
        };
        const generateError = (error: Error) => {
          me.state.errorCount++;
          pinger.stop();
          me.chalkUpError(POST_GENERATE_NAME, error);
          reject(error);
        };
        const script = fs.readFileSync(g, "utf8");
        if (!me.state.cache[me.getCacheName(POST_GENERATE_NAME)]) {
          me.state.cache[me.getCacheName(POST_GENERATE_NAME)] = {};
        }
        const code =
          "((require, resolve, reject, cache, output, log, dataDir) =>  {" +
          script +
          "})";
        try {
          vm.runInThisContext(code)(
            require,
            generateSuccess,
            generateError,
            me.state.cache[me.getCacheName(POST_GENERATE_NAME)],
            me.state.outputData,
            me.scriptLogger.bind(null, POST_GENERATE_NAME),
            fspath.resolve(me.dataDir)
          );
        } catch (error) {
          me.state.errorCount++;
          logError(error);
          reject(error);
        }
      } else {
        log(pico.blue(POST_GENERATE_JS + " not found, skipping."));
        resolve(); // no global data
      }
    });
  }

  /// -----------------------------------------------------------------------------
  /// updateDeps
  ///
  /// When watching for file changes, we make sure to
  /// trigger any dependencies to regenerate.
  /// -----------------------------------------------------------------------------
  public updateDeps(
    dependencies: Dependencies,
    dependency = "",
    reason = TriggerReason.Modified
  ): Promise<void> {
    const me = this;
    return new Promise(function (resolve, reject) {
      for (const pageName in dependencies) {
        // tell the generator that this data file
        // has changed in case it can be efficient
        me.cueGeneration(pageName, dependency, reason);
      }
      const toGenerate = Object.values(me.state.toGenerate);
      if (toGenerate.length) {
        me.generatePages()
          .then(() => {
            log(pico.green("Dependency Updates Complete."));
            return me.processPostGenerate();
          })
          .then(() => {
            resolve();
          })
          .catch((error) => {
            me.state.errorCount++;
            logError(pico.red("Dependency Updates Failed."), error);
            reject(error);
          });
      }
    });
  }

  /// -----------------------------------------------------------------------------
  /// getDataDeps
  ///
  /// It's up to generator scripts to tell us which datafiles they'd like to watch
  /// -----------------------------------------------------------------------------
  getDataDeps(path: Path): Dependencies {
    let dependencies;
    // intelligently find the dep
    // first look for direct match:
    dependencies = this.state.pathDepTree[path];
    if (dependencies) {
      log(pico.green("Update Triggered by: " + path));
    } else if (!dependencies) {
      // check for wildcard match
      const wildDeps = Object.keys(this.state.wildDepTree);
      for (let pattern of wildDeps) {
        if (micromatch.isMatch(path, "**/" + pattern)) {
          dependencies = this.state.wildDepTree[pattern];
          log(pico.green("Update Triggered by: " + path));
          break;
        }
      }
    }
    if (!dependencies) {
      log(pico.yellow("Info: No dependencies to update for " + path));
    }
    return dependencies;
  }

  /// -----------------------------------------------------------------------------
  /// updateTemplateDeps
  ///
  /// It's up to generator scripts to tell us which datafiles they'd like to watch
  /// -----------------------------------------------------------------------------
  getTemplateDeps(templateName: TemplateName): Dependencies {
    // when a template updates, we need to check its dependencies and also trigger its own
    // generation if it is a page maker

    if (this.verbose) {
      log(JSON.stringify(this.state.templateDepTree, null, "  "));
    }

    const dependencies = {
      ...(this.state.templateDepTree[templateName] || {}),
      [templateName]: true,
    };
    return dependencies;
  }

  /// -----------------------------------------------------------------------------
  /// getGlobalDeps
  ///
  /// If the global data changed, anything that depended
  /// on global data needs to be updated
  /// -----------------------------------------------------------------------------
  getGlobalDeps(): Dependencies {
    console.log(pico.green("Update Triggered by preGenerate.js change."));
    return this.state.globalDeps;
  }
}
