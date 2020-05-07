import { CryptoManager, Interfaces, Transactions } from "@arkecosystem/crypto";
import { BlockSchemaError } from "@arkecosystem/crypto/dist/errors";
import Ajv from "ajv";
import ajvKeywords from "ajv-keywords";

import { IBlockData } from "../interfaces";
import { formats } from "./formats";
import { keywords } from "./keywords";
import { schemas } from "./schemas";

export class Validator {
    private ajv: Ajv.Ajv;
    private readonly transactionSchemas: Map<string, Transactions.schemas.TransactionSchema> = new Map<
        string,
        Transactions.schemas.TransactionSchema
    >();

    private constructor(private cryptoManager: CryptoManager<IBlockData>, options: Record<string, any>) {
        this.ajv = this.instantiateAjv(options);
    }

    public static make(cryptoManager: CryptoManager<IBlockData>, options: Record<string, any> = {}): Validator {
        return new Validator(cryptoManager, options);
    }

    public getInstance(): Ajv.Ajv {
        return this.ajv;
    }

    public validate<T = any>(schemaKeyRef: string | boolean | object, data: T): Interfaces.ISchemaValidationResult<T> {
        return this.validateSchema(this.ajv, schemaKeyRef, data);
    }

    public validateException<T = any>(
        schemaKeyRef: string | boolean | object,
        data: T,
    ): Interfaces.ISchemaValidationResult<T> {
        const ajv = this.instantiateAjv({ allErrors: true, verbose: true });

        for (const schema of this.transactionSchemas.values()) {
            this.extendTransactionSchema(ajv, schema);
        }

        return this.validateSchema(ajv, schemaKeyRef, data);
    }

    public addFormat(name: string, format: Ajv.FormatDefinition): void {
        this.ajv.addFormat(name, format);
    }

    public addKeyword(keyword: string, definition: Ajv.KeywordDefinition): void {
        this.ajv.addKeyword(keyword, definition);
    }

    public addSchema(schema: object | object[], key?: string): void {
        this.ajv.addSchema(schema, key);
    }

    public removeKeyword(keyword: string): void {
        this.ajv.removeKeyword(keyword);
    }

    public removeSchema(schemaKeyRef: string | boolean | object | RegExp): void {
        this.ajv.removeSchema(schemaKeyRef);
    }

    public extendTransaction(schema: Transactions.schemas.TransactionSchema, remove?: boolean) {
        this.extendTransactionSchema(this.ajv, schema, remove);
    }

    public applySchema(data: IBlockData): IBlockData | undefined {
        let result = this.validate("block", data);

        if (!result.error) {
            return result.value;
        }

        result = this.validateException("block", data);

        if (!result.errors) {
            return result.value;
        }

        for (const err of result.errors) {
            let fatal = false;

            const match = err.dataPath.match(/\.transactions\[([0-9]+)\]/);
            if (match === null) {
                if (!this.cryptoManager.LibraryManager.Utils.isException(data.id)) {
                    fatal = true;
                }
            } else {
                const txIndex = match[1];

                if (data.transactions) {
                    const tx = data.transactions[txIndex];

                    if (tx.id === undefined || !this.cryptoManager.LibraryManager.Utils.isException(tx.id)) {
                        fatal = true;
                    }
                }
            }

            if (fatal) {
                throw new BlockSchemaError(
                    data.height,
                    `Invalid data${err.dataPath ? " at " + err.dataPath : ""}: ` +
                        `${err.message}: ${JSON.stringify(err.data)}`,
                );
            }
        }

        return result.value;
    }

    private validateSchema<T = any>(
        ajv: Ajv.Ajv,
        schemaKeyRef: string | boolean | object,
        data: T,
    ): Interfaces.ISchemaValidationResult<T> {
        try {
            ajv.validate(schemaKeyRef, data);

            const error = ajv.errors ? ajv.errorsText() : undefined;

            return { value: data, error, errors: ajv.errors || undefined };
        } catch (error) {
            return { value: undefined, error: error.stack, errors: [] };
        }
    }

    private instantiateAjv(options: Record<string, any>) {
        const ajv = new Ajv({
            ...{
                $data: true,
                schemas,
                removeAdditional: true,
                extendRefs: true,
            },
            ...options,
        });
        ajvKeywords(ajv);

        for (const addKeyword of keywords) {
            addKeyword(ajv, this.cryptoManager);
        }

        for (const addFormat of formats) {
            addFormat(ajv, this.cryptoManager);
        }

        return ajv;
    }

    private extendTransactionSchema(ajv: Ajv.Ajv, schema: Transactions.schemas.TransactionSchema, remove?: boolean) {
        if (ajv.getSchema(schema.$id)) {
            remove = true;
        }

        if (remove) {
            this.transactionSchemas.delete(schema.$id);

            ajv.removeSchema(schema.$id);
            ajv.removeSchema(`${schema.$id}Signed`);
            ajv.removeSchema(`${schema.$id}Strict`);
        }

        this.transactionSchemas.set(schema.$id, schema);

        ajv.addSchema(schema);
        ajv.addSchema(Transactions.schemas.signedSchema(schema));
        ajv.addSchema(Transactions.schemas.strictSchema(schema));

        this.updateTransactionArray(ajv);
    }

    private updateTransactionArray(ajv: Ajv.Ajv) {
        ajv.removeSchema("block");
        ajv.removeSchema("transactions");
        ajv.addSchema({
            $id: "transactions",
            type: "array",
            additionalItems: false,
            items: { anyOf: [...this.transactionSchemas.keys()].map((schema) => ({ $ref: `${schema}Signed` })) },
        });
        ajv.addSchema(schemas.block);
    }
}

// export const validator = Validator.make();