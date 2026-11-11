import { describe, expect, it } from "vitest";
import { signRequest } from "../src/lib/sigv4.js";

describe("AWS Signature Version 4", () => {
  // The worked example from AWS's documentation ("Examples of the complete
  // Signature Version 4 signing process"): IAM ListUsers, 2015-08-30.
  it("matches AWS's published example signature", async () => {
    const { signature, headers } = await signRequest({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "iam",
      date: new Date("2015-08-30T12:36:00Z"),
    });
    expect(signature).toBe("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(headers["X-Amz-Date"]).toBe("20150830T123600Z");
  });
});
