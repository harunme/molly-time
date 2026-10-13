"""Validated CI provenance and compare-and-swap publication preconditions."""

from pydantic import BaseModel, ConfigDict, Field


class ExpectedRelease(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    versionCode: int = Field(gt=0, le=2100000000)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class CiReleasePlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: int = Field(ge=1, le=1)
    requiresApk: bool
    sourceCommit: str = Field(pattern=r"^[a-f0-9]{40}$")
    sourceFingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    versionCode: int = Field(gt=0, le=2100000000)
    versionName: str = Field(min_length=1, max_length=100)
    expectedRelease: ExpectedRelease | None
    reason: str = Field(max_length=100)
    inputCount: int = Field(ge=1)
    releaseNotes: str | None = Field(default=None, max_length=4000)

    def matches(self, current) -> bool:
        if self.expectedRelease is None:
            return current is None
        return current is not None and (
            current.versionCode == self.expectedRelease.versionCode
            and current.sha256 == self.expectedRelease.sha256
        )
