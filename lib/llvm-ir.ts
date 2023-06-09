// Copyright (c) 2018, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import _ from 'underscore';

import type {IRResultLine} from '../types/asmresult/asmresult.interfaces.js';

import * as utils from './utils.js';
import {LLVMIrBackendOptions} from '../types/compilation/ir.interfaces.js';
import {LLVMIRDemangler} from './demangler/llvm.js';
import {ParseFiltersAndOutputOptions} from '../types/features/filters.interfaces.js';

export class LlvmIrParser {
    private maxIrLines: number;
    private debugReference: RegExp;
    private metaNodeRe: RegExp;
    private metaNodeOptionsRe: RegExp;
    private llvmDebug: RegExp;
    private commentOnly: RegExp;

    // TODO(jeremy-rifkin) can awful state things happen because of soring a demangler? Usually they're constructed
    // fresh for each compile.
    constructor(compilerProps, private readonly irDemangler: LLVMIRDemangler) {
        this.maxIrLines = 5000;
        if (compilerProps) {
            this.maxIrLines = compilerProps('maxLinesOfAsm', this.maxIrLines);
        }

        this.debugReference = /!dbg (!\d+)/;
        this.metaNodeRe = /^(!\d+) = (?:distinct )?!DI([A-Za-z]+)\(([^)]+?)\)/;
        this.metaNodeOptionsRe = /(\w+): (!?\d+|\w+|""|"(?:[^"]|\\")*[^\\]")/gi;
        this.llvmDebug = /^\s*call void @llvm\.dbg\..*$/;
        this.commentOnly = /^\s*(;.*)$/;
    }

    getFileName(debugInfo, scope): string | null {
        const stdInLooking = /.*<stdin>|^-$|example\.[^/]+$|<source>/;

        if (!debugInfo[scope]) {
            // No such meta info.
            return null;
        }
        // MetaInfo is a file node
        if (debugInfo[scope].filename) {
            const filename = debugInfo[scope].filename;
            return stdInLooking.test(filename) ? null : filename;
        }
        // MetaInfo has a file reference.
        if (debugInfo[scope].file) {
            return this.getFileName(debugInfo, debugInfo[scope].file);
        }
        if (!debugInfo[scope].scope) {
            // No higher scope => can't find file.
            return null;
        }
        // "Bubbling" up.
        return this.getFileName(debugInfo, debugInfo[scope].scope);
    }

    getSourceLineNumber(debugInfo, scope) {
        if (!debugInfo[scope]) {
            return null;
        }
        if (debugInfo[scope].line) {
            return Number(debugInfo[scope].line);
        }
        if (debugInfo[scope].scope) {
            return this.getSourceLineNumber(debugInfo, debugInfo[scope].scope);
        }
        return null;
    }

    getSourceColumn(debugInfo, scope): number | undefined {
        if (!debugInfo[scope]) {
            return;
        }
        if (debugInfo[scope].column) {
            return Number(debugInfo[scope].column);
        }
        if (debugInfo[scope].scope) {
            return this.getSourceColumn(debugInfo, debugInfo[scope].scope);
        }
    }

    parseMetaNode(line) {
        // Metadata Nodes
        // See: https://llvm.org/docs/LangRef.html#metadata
        const match = line.match(this.metaNodeRe);
        if (!match) {
            return null;
        }
        const metaNode = {
            metaId: match[1],
            metaType: match[2],
        };

        let keyValuePair;
        while ((keyValuePair = this.metaNodeOptionsRe.exec(match[3]))) {
            const key = keyValuePair[1];
            metaNode[key] = keyValuePair[2];
            // Remove "" from string
            if (metaNode[key][0] === '"') {
                metaNode[key] = metaNode[key].substr(1, metaNode[key].length - 2);
            }
        }

        return metaNode;
    }

    async processIr(ir, filters: LLVMIrBackendOptions) {
        const result: IRResultLine[] = [];
        const irLines = utils.splitLines(ir);
        const debugInfo = {};
        let prevLineEmpty = false;

        for (const line of irLines) {
            if (line.trim().length === 0) {
                // Avoid multiple successive empty lines.
                if (!prevLineEmpty) {
                    result.push({text: ''});
                }
                prevLineEmpty = true;
                continue;
            }

            if (filters.comments && this.commentOnly.test(line)) {
                continue;
            }
            if (filters.filterDebugInfo && this.llvmDebug.test(line)) {
                continue;
            }

            // Non-Meta IR line. Metadata is attached to it using "!dbg !123"
            const match = line.match(this.debugReference);
            if (match) {
                result.push({
                    text: line,
                    scope: match[1],
                });
                prevLineEmpty = false;
                continue;
            }

            const metaNode = this.parseMetaNode(line);
            if (metaNode) {
                debugInfo[metaNode.metaId] = metaNode;
            }

            if (filters.filterIRMetadata && this.isLineLlvmDirective(line)) {
                continue;
            }
            result.push({text: line});
            prevLineEmpty = false;
        }

        if (result.length >= this.maxIrLines) {
            result.length = this.maxIrLines + 1;
            result[this.maxIrLines] = {text: '[truncated; too many lines]'};
        }

        for (const line of result) {
            if (!line.scope) continue;
            line.source = {
                file: this.getFileName(debugInfo, line.scope),
                line: this.getSourceLineNumber(debugInfo, line.scope),
                column: this.getSourceColumn(debugInfo, line.scope),
            };
        }

        if (filters.demangle) {
            //this.irDemangler.collect({asm: result});
            return {
                asm: await this.irDemangler.process({asm: result}),
                labelDefinitions: {},
                languageId: 'llvm-ir',
            };
        } else {
            return {
                asm: result,
                labelDefinitions: {},
                languageId: 'llvm-ir',
            };
        }
    }

    async processFromFilters(ir, filters: ParseFiltersAndOutputOptions) {
        if (_.isString(ir)) {
            return await this.processIr(ir, {
                filterDebugInfo: !!filters.debugCalls,
                filterIRMetadata: filters.directives,
                demangle: filters.demangle,
                comments: filters.commentOnly,
                // discard value names is handled earlier
            });
        }
        return {
            asm: [],
            labelDefinitions: {},
        };
    }

    async process(ir: string, irOptions: LLVMIrBackendOptions) {
        return await this.processIr(ir, irOptions);
    }

    isLineLlvmDirective(line) {
        return !!(
            /^!\d+ = (distinct )?!(DI|{)/.test(line) ||
            line.startsWith('!llvm') ||
            line.startsWith('source_filename = ') ||
            line.startsWith('target datalayout = ') ||
            line.startsWith('target triple = ')
        );
    }

    isLlvmIr(code) {
        return code.includes('@llvm') && code.includes('!DI') && code.includes('!dbg');
    }
}
