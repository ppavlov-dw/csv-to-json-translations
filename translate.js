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

const run = ({ source, destinations, cwd: inputCwd, core, verbose }) => {
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
      "verbose",
      verbose
    );

  const cwd = path.resolve(inputCwd || process.cwd());
  console.log("cwd", cwd);

  const translationsContentPath = path.resolve(cwd, source);
  console.log(`Checking for translations CSV at ${translationsContentPath}`);

  const translationsContent = fs.readFileSync(path.resolve(cwd, source));
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
        path.basename(filePath, ".json") === sourceLang
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
          const fileLocale = path.basename(filePath, ".json");

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
          }
        });
      });
  });

  console.log(`Writing ${changedFiles.length} changed files`);
  verbose && console.log(JSON.stringify(changedFiles, null, 2));

  Object.entries(files).forEach(([filePath, fileContent]) => {
    fs.writeFileSync(
      filePath,
      JSON.stringify(unflattenObject(fileContent), null, 2) + "\n"
    );
  });
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
    run
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
  .option("verbose", {
    alias: "v",
    type: "boolean",
    description: "Enables verbose logging",
  })
  .parse();
