package checker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/rs/zerolog/log"
)

type UpdateData struct {
	MonitorId     string `json:"monitorId"`
	Status        string `json:"status"`
	Message       string `json:"message,omitempty"`
	Region        string `json:"region"`
	CronTimestamp int64  `json:"cronTimestamp"`
	StatusCode    int    `json:"statusCode,omitempty"`
	Latency       int64  `json:"latency,omitempty"`
}

func UpdateStatus(ctx context.Context, updateData UpdateData) error {
	workflowsURL := os.Getenv("WORKFLOWS_URL")
	if workflowsURL == "" {
		return fmt.Errorf("WORKFLOWS_URL is required")
	}

	payloadBuf := new(bytes.Buffer)
	if err := json.NewEncoder(payloadBuf).Encode(updateData); err != nil {
		log.Ctx(ctx).Error().Err(err).Msg("error while updating status")
		return err
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		workflowsURL+"/updateStatus",
		payloadBuf,
	)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Basic "+os.Getenv("CRON_SECRET"))
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("workflows returned %d", resp.StatusCode)
	}
	return nil
}
