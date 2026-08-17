-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "analysis" TEXT,
ADD COLUMN     "analysisError" TEXT,
ADD COLUMN     "analysisStatus" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "analyzedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "File_analysisStatus_idx" ON "File"("analysisStatus");
