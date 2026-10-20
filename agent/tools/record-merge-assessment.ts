import { defineTool } from "eve/tools";
import { assessmentInput, recordMergeAssessment } from "@/merge-assessment";

export default defineTool({
  description:
    "Record the completed review's merge assessment for the current PR and head SHA. Account for every material change. This records review judgment; the native merge tool separately checks fresh GitHub readiness. Publish the returned status and rationale in the PR summary before merging.",
  inputSchema: assessmentInput,
  execute(input, ctx) {
    return recordMergeAssessment(input, ctx);
  },
});
