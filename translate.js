#!/usr/bin/env node

const fs = require("fs");
const glob = require("glob");
const path = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const csv = require("csv-parse/sync");

const findPaths = (text, allTexts) =>
  Object.keys(allTexts).filter(
    (key) => allTexts[key] === `$${text}$` || allTexts[key] === text
  );

const findKeys = (text, allTexts) =>
  Object.keys(allTexts).filter((key) =>
    key.split(".").some((part) => part === `$${text}$` || part === text)
  );

const flattenObject = (obj, prefix = "") =>
  Object.entries(obj).reduce((acc, [key, value]) => {
    const currentPath = prefix.length ? prefix + "." : "";

    if (typeof value === "object") {
      return {
        ...acc,
        ...flattenObject(value, currentPath + key),
      };
    }

    return {
      ...acc,
      [currentPath + key]: value,
    };
  }, {});

const isArrayLikeObject = (obj) =>
  Object.keys(obj).every((key, i) => parseInt(key) === i);

const convertArrayLikeObjects = (obj) => {
  Object.entries(obj).forEach(([key, value]) => {
    if (typeof value === "object") {
      if (isArrayLikeObject(value)) {
        obj[key] = Object.values(value);
        obj[key].forEach(convertArrayLikeObjects);
      } else {
        convertArrayLikeObjects(value);
      }
    }
  });
};

const unflattenObject = (obj) => {
  const result = {};

  Object.keys(obj).forEach((key) => {
    const keys = key.split(".");
    let currentObj = result;

    keys.forEach((currentKey, i) => {
      if (i === keys.length - 1) {
        currentObj[currentKey] = obj[key];
      } else {
        if (!currentObj[currentKey]) {
          currentObj[currentKey] = {};
        }
        currentObj = currentObj[currentKey];
      }
    });
  });

  convertArrayLikeObjects(result);

  return result;
};

const getFileLocale = (filePath, source) => {
  switch (source) {
    case "filename":
      return path.basename(filePath, ".json");

    case "dirname":
      return path.basename(path.dirname(filePath));
  }

  return null;
};

const getFileBrand = (filePath, brandPosition) => {
  return filePath.split(path.sep).reverse()[brandPosition];
};

const setFileBrand = (filePath, brandPosition, brand) => {
  const parts = filePath.split(path.sep).reverse();

  parts[brandPosition] = brand;

  return parts.reverse().join(path.sep);
};

const writeChanges = (files, changedFiles, verbose) => {
  console.log(`Writing ${changedFiles.length} changed files`);
  verbose && console.log(JSON.stringify(changedFiles, null, 2));

  Object.entries(files).forEach(([filePath, fileContent]) => {
    fs.writeFileSync(
      filePath,
      JSON.stringify(unflattenObject(fileContent), null, 2) + "\n"
    );
  });
};

const translate = ({
  source,
  destinations,
  cwd: inputCwd,
  core,
  fileLocaleSource,
  translateKeys,
  verbose,
}) => {
  verbose &&
    console.log(
      "source",
      source,
      "destinations",
      destinations,
      "inputCwd",
      inputCwd,
      "core",
      core,
      "fileLocaleSource",
      fileLocaleSource,
      "translateKeys",
      translateKeys,
      "verbose",
      verbose
    );

  const cwd = path.resolve(inputCwd || process.cwd());
  console.log("cwd", cwd);

  const translationsContentPath = path.resolve(cwd, source);
  console.log(`Checking for translations CSV at ${translationsContentPath}`);

  const translationsContent = fs.readFileSync(translationsContentPath);
  const translations = csv.parse(translationsContent, {
    columns: true,
  });
  verbose &&
    console.log("Translations found", JSON.stringify(translations, null, 2));

  const sourceLang = Object.keys(translations[0])[0];
  console.log("Source language", sourceLang);

  const filePaths = glob.sync(destinations, { cwd });
  console.log(`Found ${filePaths.length} destination files`);
  verbose && console.log(JSON.stringify(filePaths, null, 2));

  const files = filePaths
    .map((filePath) => path.resolve(cwd, filePath))
    .reduce(
      (acc, filePath) => ({
        ...acc,
        [filePath]: flattenObject(
          JSON.parse(fs.readFileSync(filePath).toString())
        ),
      }),
      {}
    );
  verbose &&
    console.log(
      "Flattened destination contents",
      JSON.stringify(files, null, 2)
    );

  const coreTranslationsRelPath =
    core ||
    filePaths.find(
      (filePath) =>
        filePath.includes("core") &&
        getFileLocale(filePath, fileLocaleSource) === sourceLang
    );
  console.log(
    `Core translations file relative path at ${coreTranslationsRelPath}`
  );
  const coreTranslationsPath = path.resolve(cwd, coreTranslationsRelPath);
  console.log(
    `Checking for the core translations file at ${coreTranslationsPath}`
  );

  const coreTranslations = flattenObject(
    JSON.parse(fs.readFileSync(coreTranslationsPath).toString())
  );
  verbose &&
    console.log(
      "Core translations found",
      JSON.stringify(coreTranslations, null, 2)
    );

  const changedFiles = [];

  translations.forEach((translationLine) => {
    Object.entries(translationLine)
      .filter(
        ([locale, translation]) =>
          locale !== sourceLang && translation.trim() && translation !== "N/A"
      )
      .forEach(([locale, translation]) => {
        verbose &&
          console.log(
            `Translating "${translationLine[sourceLang]}" to "${translation}" in ${locale}`
          );

        Object.entries(files).forEach(([filePath, fileContent]) => {
          const fileLocale = getFileLocale(filePath, fileLocaleSource);

          if (fileLocale.startsWith(locale)) {
            verbose && console.log(`  - Checking ${filePath}`);

            let translationPaths = findPaths(
              translationLine[sourceLang],
              fileContent
            );

            translationPaths.length &&
              verbose &&
              console.log(
                `    - Found at paths ${JSON.stringify(translationPaths)}`
              );

            if (
              !translationPaths.length &&
              filePath.includes("core") &&
              !fileLocale.includes("-")
            ) {
              translationPaths = findPaths(
                translationLine[sourceLang],
                coreTranslations
              );
              verbose &&
                console.log(
                  `    - Found at core paths ${JSON.stringify(
                    translationPaths
                  )}`
                );
            }

            if (translationPaths.length) {
              verbose && console.log("    - Substituting");

              translationPaths.forEach((translationPath) => {
                fileContent[translationPath] = translation;
              });

              if (!changedFiles.includes(filePath)) {
                changedFiles.push(filePath);
              }
            }

            if (translateKeys) {
              let translationKeys = findKeys(
                translationLine[sourceLang],
                fileContent
              );

              translationKeys.length &&
                verbose &&
                console.log(
                  `    - Found in keys ${JSON.stringify(translationKeys)}`
                );

              if (translationKeys.length) {
                verbose && console.log("    - Substituting");

                translationKeys.forEach((translationKey) => {
                  const translatedKey = translationKey.replace(
                    translationLine[sourceLang],
                    translation
                  );

                  if (translatedKey !== translationKey) {
                    fileContent[translatedKey] = fileContent[translationKey];
                    delete fileContent[translationKey];

                    if (!changedFiles.includes(filePath)) {
                      changedFiles.push(filePath);
                    }
                  }
                });
              }
            }
          }
        });
      });
  });

  writeChanges(files, changedFiles, verbose);
};

const normalise = ({
  filesPattern,
  cwd: inputCwd,
  brandPosition,
  baseBrandName,
  fileLocaleSource,
  verbose,
}) => {
  verbose &&
    console.log(
      "filesPattern",
      filesPattern,
      "inputCwd",
      inputCwd,
      "brandPosition",
      brandPosition,
      "baseBrandName",
      baseBrandName,
      "fileLocaleSource",
      fileLocaleSource,
      "verbose",
      verbose
    );

  const cwd = path.resolve(inputCwd || process.cwd());
  console.log("cwd", cwd);

  const filePaths = glob.sync(filesPattern, { cwd });
  console.log(`Found ${filePaths.length} destination files`);
  verbose && console.log(JSON.stringify(filePaths, null, 2));

  const files = filePaths
    .map((filePath) => path.resolve(cwd, filePath))
    .reduce(
      (acc, filePath) => ({
        ...acc,
        [filePath]: flattenObject(
          JSON.parse(fs.readFileSync(filePath).toString())
        ),
      }),
      {}
    );
  verbose &&
    console.log(
      "Flattened destination contents",
      JSON.stringify(files, null, 2)
    );

  const changedFiles = [];

  Object.entries(files).forEach(([filePath, fileContent]) => {
    const locale = getFileLocale(filePath, fileLocaleSource);
    const lang = locale.slice(0, 2);
    const regional = lang !== locale;
    const brand = getFileBrand(filePath, brandPosition);

    const baseFilePath = setFileBrand(filePath, brandPosition, baseBrandName);

    const baseFiles = [
      ...(brand !== baseBrandName ? [baseFilePath] : []),
      ...(regional
        ? [
            ...(brand !== baseBrandName
              ? [baseFilePath.replace(locale, lang)]
              : []),
            filePath.replace(locale, lang),
          ]
        : []),
    ].filter(fs.existsSync);

    const duplicates = Object.entries(fileContent).filter(([key, value]) =>
      baseFiles.some(
        (baseFilePath) =>
          files[baseFilePath][key] === value ||
          (value.startsWith("$") &&
            value.endsWith("$") &&
            files[baseFilePath][key] &&
            !(
              files[baseFilePath][key].startsWith("$") &&
              files[baseFilePath][key].endsWith("$")
            ))
      )
    );

    verbose &&
      console.log(
        `Processing ${filePath}; brand: ${brand}, locale: ${locale}, lang: ${lang}, regional: ${regional}; baseFiles: ${JSON.stringify(
          baseFiles,
          null,
          2
        )}; Found duplicates: ${duplicates.length}`
      );

    if (duplicates.length) {
      duplicates.forEach(([key, value]) => {
        if (verbose) {
          console.log(
            `Duplicate translation of ${key} in ${filePath}: ${value}`
          );
        }

        delete fileContent[key];

        if (!changedFiles.includes(filePath)) {
          changedFiles.push(filePath);
        }
      });
    }
  });

  writeChanges(files, changedFiles, verbose);
};

yargs(hideBin(process.argv))
  .command(
    "$0 <source> <destinations>",
    "Apply translations from CSV to JSON files",
    (yargs) =>
      yargs
        .positional("source", {
          describe:
            "Path to the source CSV containing the translations to apply; absolute or relative to cwd",
        })
        .positional("destinations", {
          describe: "Glob that resolves to all destination JSON files",
        }),
    translate
  )
  .option("cwd", {
    type: "string",
    description:
      "Path to the base directory all other paths will be based on, defaults to the current cwd",
  })
  .option("core", {
    type: "string",
    description:
      'Path to the core translations in the default language, defaults to the first file for the source language that has "core" in its path',
  })
  .option("fileLocaleSource", {
    type: "string",
    choices: ["filename", "dirname"],
    default: "filename",
    description:
      "How the file's locale will be determined based on its full path",
  })
  .option("translateKeys", {
    type: "boolean",
    description: "Will check for translations in JSON keys as well as values",
  })
  .option("verbose", {
    alias: "v",
    type: "boolean",
    description: "Enables verbose logging",
  })
  .command(
    "normalise <filesPattern>",
    "Normalises translations in JSON files - remove translations that are unnecessarily overridden in a base file",
    (yargs) =>
      yargs.positional("filesPattern", {
        describe: "Glob that resolves to all destination JSON files",
      }),
    normalise
  )
  .option("cwd", {
    type: "string",
    description:
      "Path to the base directory all other paths will be based on, defaults to the current cwd",
  })
  .option("brandPosition", {
    type: "string",
    default: 3,
    description:
      "How many segments back we have to go from the filename to find the brand of each translations file; defaults to 3",
  })
  .option("baseBrandName", {
    type: "string",
    default: "core",
    description: 'Name of the base "brand", defaults to "core"',
  })
  .option("fileLocaleSource", {
    type: "string",
    choices: ["filename", "dirname"],
    default: "filename",
    description:
      "How the file's locale will be determined based on its full path",
  })
  .option("verbose", {
    alias: "v",
    type: "boolean",
    description: "Enables verbose logging",
  })
  .parse();
