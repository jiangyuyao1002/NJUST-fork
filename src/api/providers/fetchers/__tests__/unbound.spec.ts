vi.mock("axios")

import type { Mock } from "vitest"
import axios from "axios"
import { getUnboundModels } from "../unbound"

const mockedAxios = axios as typeof axios & {
	get: Mock
}

describe("getUnboundModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("ignores model entries that fail response schema validation", async () => {
		mockedAxios.get.mockResolvedValue({
			data: {
				data: [
					{
						id: "valid-model",
						max_output_tokens: 4096,
						context_window: 128000,
					},
					{
						max_output_tokens: 8192,
						context_window: 200000,
					},
				],
			},
		})

		const result = await getUnboundModels("test-key")

		expect(Object.keys(result)).toEqual(["valid-model"])
	})
})
