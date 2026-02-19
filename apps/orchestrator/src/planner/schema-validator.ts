import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import plannerSchema from "../../../../contracts/planner.schema.json";
import snapshotSchema from "../../../../contracts/snapshot.schema.json";
import type { PlannerRequestV1, PlannerResponseV1 } from "../../../../contracts/planner";
import type { SnapshotV1 } from "../../../../contracts/snapshot";

export class SchemaValidator {
  private readonly validatePlannerRequestFn: ValidateFunction<PlannerRequestV1>;

  private readonly validatePlannerResponseFn: ValidateFunction<PlannerResponseV1>;

  private readonly validateSnapshotFn: ValidateFunction<SnapshotV1>;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(plannerSchema);
    ajv.addSchema(snapshotSchema);

    const plannerSchemaId = (plannerSchema as { $id?: string }).$id;
    const snapshotSchemaId = (snapshotSchema as { $id?: string }).$id;
    if (!plannerSchemaId || !snapshotSchemaId) {
      throw new Error("contracts schemas must define $id");
    }

    this.validatePlannerRequestFn = ajv.compile({
      $ref: `${plannerSchemaId}#/$defs/PlannerRequestV1`
    });
    this.validatePlannerResponseFn = ajv.compile({
      $ref: `${plannerSchemaId}#/$defs/PlannerResponseV1`
    });
    this.validateSnapshotFn = ajv.compile({ $ref: snapshotSchemaId });
  }

  validateSnapshot(input: SnapshotV1): void {
    if (!this.validateSnapshotFn(input)) {
      throw new Error(this.humanizeErrors(this.validateSnapshotFn.errors));
    }
  }

  validatePlannerRequest(input: PlannerRequestV1): void {
    if (!this.validatePlannerRequestFn(input)) {
      throw new Error(this.humanizeErrors(this.validatePlannerRequestFn.errors));
    }
  }

  validatePlannerResponse(input: PlannerResponseV1): void {
    if (!this.validatePlannerResponseFn(input)) {
      throw new Error(this.humanizeErrors(this.validatePlannerResponseFn.errors));
    }
  }

  private humanizeErrors(errors: ErrorObject[] | null | undefined): string {
    if (!errors || errors.length === 0) {
      return "unknown schema validation error";
    }

    return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
  }
}
