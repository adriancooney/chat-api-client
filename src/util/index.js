export prompt, { Prompt } from "./prompt";

export function indent(str, indent = "  ") {
    return indent + str.split("\n").join(`\n${indent}`);
}